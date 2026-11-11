//! The audio thread's side of the engine.

use std::mem;
use std::ops::ControlFlow;

use engine_plugins::SampleRate;

use crate::builder::{FIRST_CELLS, FIRST_EXITS, FIRST_PATTERN_CELLS};
use crate::commands::{Command, CommandInput, Drained};
use crate::events::{EngineEvent, EventOutput};
use crate::graph::{Graph, Nodes};
use crate::handle::NodeHandle;
use crate::handoff::{Arrival, AudioEnd, Batch, Edit, Parcel};
use crate::heap;
use crate::node::page_param;
use crate::notes::page_note;
use crate::schema::Rejection;
use crate::sequencer::{Arrangement, Held, Patterns, Sequencer};
use crate::strip::page_strip_param;
use crate::telemetry::{BlockMeter, Telemetry};
use crate::transport::{Place, Transport};
use crate::{BLOCK_FRAMES, Block, SILENCE, hang};

/// The audio thread's part: plays, applies live edits and swaps parcels in.
pub struct Engine {
    graph: Graph,
    parcels: AudioEnd,
    /// Samples rendered.
    clock: u64,
    /// Not part of a session: a reset leaves it, so a rebuild doesn't start the pattern over.
    transport: Transport,
    /// Its patterns and clips are of the session: the reset's parcel takes them away.
    sequencer: Sequencer,
    held: Held,
    input: CommandInput,
    events: EventOutput,
    output: Block,
    /// The output's.
    meter: BlockMeter,
    telemetry: Telemetry,
}

impl Engine {
    pub(crate) fn new(sample_rate: SampleRate, parcels: AudioEnd) -> Self {
        Self {
            graph: Graph::new(
                Nodes::new(FIRST_CELLS),
                Nodes::new(FIRST_EXITS),
                sample_rate,
            ),
            parcels,
            clock: 0,
            transport: Transport::new(sample_rate),
            sequencer: Sequencer {
                patterns: Patterns::new(FIRST_PATTERN_CELLS),
                arrangement: Arrangement::default(),
            },
            held: Held::new(),
            input: CommandInput::default(),
            events: EventOutput::default(),
            output: SILENCE,
            meter: BlockMeter::new(sample_rate),
            telemetry: Telemetry::default(),
        }
    }

    /// A block as the audio thread runs it: commands, sound, then the events that fit into `room` bytes; returns
    /// their size. The heap count goes to the telemetry last, so it holds every call of the block.
    pub fn audio_block(&mut self, frames: usize, room: usize) -> usize {
        self.process(frames);
        let handed = self.take_events(room).len();
        self.telemetry.heap_calls = heap::calls();
        handed
    }

    pub fn input(&mut self) -> &mut CommandInput {
        &mut self.input
    }

    pub fn events(&self) -> &EventOutput {
        &self.events
    }

    /// Hands out the events that fit into `room` bytes; the rest are lost and counted.
    pub(crate) fn take_events(&mut self, room: usize) -> &[u8] {
        let (bytes, lost) = self.events.take(room);
        add_to_board(&mut self.telemetry.lost_events, lost);
        bytes
    }

    /// Applies commands, renders at most [`BLOCK_FRAMES`] frames, gives back the parcels whose fades are over and
    /// updates the telemetry.
    pub(crate) fn process(&mut self, frames: usize) {
        self.apply_commands();
        let frames = frames.min(BLOCK_FRAMES);
        let playing = self.transport.playing();
        let position = self.transport.position();
        let loop_ticks = self.transport.loop_ticks();
        let lost =
            self.sequencer
                .hand_out(&mut self.held, &self.transport, &mut self.graph, frames);
        self.graph.process(frames, &mut self.output);
        self.transport.advance(frames);
        self.clock += frames as u64;
        let graph = &mut self.graph;
        self.parcels
            .release(self.clock, |parcel| take_back(parcel, graph));

        let telemetry = &mut self.telemetry;
        telemetry.blocks = telemetry.blocks.wrapping_add(1);
        add_to_board(&mut telemetry.lost_notes, lost);
        telemetry.playing = playing.into();
        telemetry.position = position;
        telemetry.loop_ticks = loop_ticks.unwrap_or(0);
        telemetry.tempo = self.transport.tempo();
        self.meter.update(&self.output, frames);
        telemetry.peaks = self.meter.levels();
        self.meter.count_overs(&mut telemetry.overs);
        telemetry.meters_used = 0;
        self.graph.each_meter(|meter| meter.report(telemetry));
    }

    pub fn telemetry(&self) -> &Telemetry {
        &self.telemetry
    }

    pub fn output(&self, channel: usize) -> &[f32; BLOCK_FRAMES] {
        &self.output[channel]
    }

    /// A batch's parcel is applied at its marker, so it keeps its place among live edits.
    fn apply_commands(&mut self) {
        let Self {
            graph,
            parcels,
            clock,
            transport,
            sequencer,
            held,
            input,
            events,
            telemetry,
            ..
        } = self;
        let drained = input.drain(|command| {
            let applied = match command {
                Ok(Command::SetParam(set)) => graph
                    .node_mut(NodeHandle::new(set.node()))
                    .ok_or(Rejection::UnknownTarget)
                    .and_then(|node| node.set_param(page_param(set.param())?, set.value())),
                Ok(Command::SetStripParam(set)) => graph
                    .node_mut(NodeHandle::new(set.node()))
                    .ok_or(Rejection::UnknownTarget)
                    .and_then(|node| {
                        node.set_strip_param(page_strip_param(set.param())?, set.value())
                    }),
                Ok(Command::NoteOn(note)) => graph
                    .node_mut(NodeHandle::new(note.node()))
                    .ok_or(Rejection::UnknownTarget)
                    .and_then(|node| {
                        node.note_on(0, note.key(), note.velocity(), page_note(note.note())?)
                    }),
                Ok(Command::NoteOff(note)) => graph
                    .node_mut(NodeHandle::new(note.node()))
                    .ok_or(Rejection::UnknownTarget)
                    .and_then(|node| node.note_off(0, page_note(note.note())?)),
                Ok(Command::SetTempo(tempo)) => transport.set_tempo(tempo.bpm()),
                Ok(Command::SetTransport(state)) => transport.set(
                    state.playing(),
                    state.loop_ticks(),
                    Place {
                        press: state.place().press(),
                        tick: state.place().tick(),
                    },
                ),
                Ok(Command::PanicAudio(panic)) => panic!("PanicAudio {}", panic.code()),
                Ok(Command::HangAudio(_)) => hang(),
                Ok(Command::AfterBatch(marker)) => match parcels.take(Batch::new(marker.batch())) {
                    Arrival::Here(mut parcel) => {
                        apply(&mut parcel, graph, sequencer, held, events, telemetry);
                        if parcel.holds {
                            // Its fades start with this block.
                            parcels.hold(parcel, *clock + u64::from(graph.fade()));
                        } else {
                            parcels.give_back(parcel);
                        }
                        Ok(())
                    }
                    Arrival::NotYet => return ControlFlow::Break(()),
                    Arrival::NotNext => Err(Rejection::UnknownTarget),
                },
                Err(reason) => Err(reason),
            };
            if let Err(reason) = applied {
                report(events, telemetry, EngineEvent::CommandRejected(reason));
            }
            ControlFlow::Continue(())
        });
        if drained == Drained::Lost {
            report(events, telemetry, EngineEvent::CommandStreamLost);
        }
        // No marker will come, and the build thread frees what it built.
        if input.is_lost() {
            parcels.send_back_unapplied();
        }
        telemetry.stream_lost = input.is_lost().into();
    }
}

/// Swaps every edit in; the parcel then holds what they displaced.
fn apply(
    parcel: &mut Parcel,
    graph: &mut Graph,
    sequencer: &mut Sequencer,
    held: &mut Held,
    events: &mut EventOutput,
    telemetry: &mut Telemetry,
) {
    let Parcel { batch, edits, .. } = parcel;
    for edit in edits {
        let refused = match edit {
            Edit::Reset(epoch) => {
                telemetry.epoch = *epoch;
                None
            }
            Edit::Grow { table, nodes } => {
                graph.grow(*table, nodes);
                None
            }
            // Only if the build thread's record went wrong.
            Edit::CreateNode { cell, node } => {
                (!graph.insert(*cell, node)).then_some(Rejection::InvalidHandle)
            }
            Edit::Remove { cell, exit, .. } => {
                (!graph.remove(*cell, *exit)).then_some(Rejection::InvalidHandle)
            }
            Edit::Order(order) => {
                graph.reorder(order);
                None
            }
            Edit::GrowPatterns(larger) => {
                sequencer.patterns.grow(larger);
                None
            }
            // Only if the build thread's record went wrong.
            Edit::Pattern { cell, pattern } => {
                (!sequencer.patterns.put(*cell, pattern)).then_some(Rejection::InvalidHandle)
            }
            Edit::Arrangement(heard) => {
                mem::swap(&mut sequencer.arrangement, heard);
                None
            }
            Edit::LetGo(nodes) => {
                held.let_go_of(nodes);
                None
            }
            Edit::Refused(reason) => Some(*reason),
        };
        if let Some(reason) = refused {
            let batch = *batch;
            report(
                events,
                telemetry,
                EngineEvent::EditRejected { batch, reason },
            );
        }
    }
}

/// The nodes the parcel removed have played out: they go back with it.
fn take_back(parcel: &mut Parcel, graph: &mut Graph) {
    for edit in &mut parcel.edits {
        if let Edit::Remove { exit, node, .. } = edit {
            graph.take_back(*exit, node);
        }
    }
}

/// Without room the event is lost and counted.
fn report(events: &mut EventOutput, telemetry: &mut Telemetry, event: EngineEvent) {
    if !events.push(telemetry.epoch, event) {
        add_to_board(&mut telemetry.lost_events, 1);
    }
}

/// Adds a block's count to one on the board.
#[expect(
    clippy::cast_possible_truncation,
    reason = "the board's count wraps around, so only the low bits of the block's count matter"
)]
fn add_to_board(board: &mut u32, count: usize) {
    *board = board.wrapping_add(count as u32);
}

#[cfg(test)]
mod tests;
