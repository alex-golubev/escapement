//! The clips heard: the notes each block passes, of the patterns they play, go to their nodes, each at the frame that
//! passes its tick, and each is let go of at the frame that passes its end.

use std::mem;

use engine_plugins::NoteId;

use crate::graph::Graph;
use crate::handle::{NodeHandle, PatternCell, PatternHandle};
use crate::notes::PAGE_NOTES;
use crate::transport::{Transport, within};

/// Notes a block hands out at most, to all nodes together: however many notes a pattern has on a tick, and however short
/// its loop, a block's work stays bounded. Past it, notes are lost and counted.
pub(crate) const NOTE_BUDGET: usize = 1024;

/// Notes held down at most, of all nodes together. A note past them is lost and counted, rather than pressed and never
/// let go of.
pub(crate) const HELD_ROOM: usize = 1024;

/// A note as the build thread checked it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Note {
    /// From the pattern's start.
    pub tick: u32,
    pub node: NodeHandle,
    pub key: u8,
    /// Between 0 and 1.
    pub velocity: f32,
    /// Ticks, from 1.
    pub length: u32,
}

/// Sorted by tick. Only parcels swap one in or out, so the audio thread never allocates or frees one.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct Pattern(Box<[Note]>);

impl Pattern {
    /// Allocates, so only on the build thread. Notes of one tick keep their order.
    pub(crate) fn new(mut notes: Vec<Note>) -> Self {
        notes.sort_by_key(|note| note.tick);
        Self(notes.into_boxed_slice())
    }

    #[cfg(test)]
    pub(crate) fn notes(&self) -> &[Note] {
        &self.0
    }

    /// Both ends included.
    fn between(&self, first: u32, last: u32) -> &[Note] {
        let start = self.0.partition_point(|note| note.tick < first);
        let end = self.0.partition_point(|note| note.tick <= last);
        &self.0[start..end]
    }
}

/// A cell of the pattern table: the pattern made there, under its handle.
pub(crate) type Made = Option<(PatternHandle, Pattern)>;

/// The patterns by their cells. Parcels bring a larger table when they need one, as they do the nodes'.
#[derive(Debug, Default)]
pub(crate) struct Patterns(Box<[Made]>);

impl Patterns {
    /// Allocates, so only on the build thread, or before the audio thread starts.
    pub(crate) fn new(cells: usize) -> Self {
        Self((0..cells).map(|_| None).collect())
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.0.len()
    }

    /// None for a handle of another generation, or past the table.
    fn get(&self, handle: PatternHandle) -> Option<&Pattern> {
        match self.0.get(handle.cell().index()) {
            Some(Some((made, pattern))) if *made == handle => Some(pattern),
            _ => None,
        }
    }

    /// Swaps `slot` into the cell; what was there comes back in it. False past the table: `slot` stays as it was.
    #[must_use]
    pub(crate) fn put(&mut self, cell: PatternCell, slot: &mut Made) -> bool {
        let Some(cell) = self.0.get_mut(cell.index()) else {
            return false;
        };
        mem::swap(cell, slot);
        true
    }

    /// Every pattern moves over to `larger`, which takes this table's place; this one, empty, is left in it.
    pub(crate) fn grow(&mut self, larger: &mut Patterns) {
        for (old, new) in self.0.iter_mut().zip(larger.0.iter_mut()) {
            mem::swap(old, new);
        }
        mem::swap(self, larger);
    }
}

/// A pattern played from a tick of the loop, round and round, as the build thread checked it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Clip {
    pub tick: u32,
    /// The last tick it plays, both ends included.
    pub last: u32,
    /// Ticks, from 1: the pattern starts again every so many of the clip's.
    pub period: u32,
    /// Ticks into a round of its pattern the clip starts at, under its period.
    pub offset: u32,
    pub pattern: PatternHandle,
}

/// The clips heard, sorted by tick, and the most ticks any of them goes on past its own: a clip that starts more than
/// these before a tick is over by it.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct Arrangement {
    clips: Box<[Clip]>,
    longest: u32,
}

impl Arrangement {
    /// Allocates, so only on the build thread. Clips of one tick keep their order.
    pub(crate) fn new(mut clips: Vec<Clip>) -> Self {
        clips.sort_by_key(|clip| clip.tick);
        let longest = clips.iter().map(|clip| clip.last - clip.tick).max();
        Self {
            clips: clips.into_boxed_slice(),
            longest: longest.unwrap_or(0),
        }
    }

    #[cfg(test)]
    pub(crate) fn clips(&self) -> &[Clip] {
        &self.clips
    }

    /// The clips that play a tick from `first` to `last`, both included.
    fn playing(&self, first: u32, last: u32) -> impl Iterator<Item = &Clip> {
        let start = first.saturating_sub(self.longest);
        let from = self.clips.partition_point(|clip| clip.tick < start);
        let to = self.clips.partition_point(|clip| clip.tick <= last);
        self.clips[from..to]
            .iter()
            .filter(move |clip| clip.last >= first)
    }
}

/// What the transport plays: the patterns, and the clips that play them.
#[derive(Debug, Default)]
pub(crate) struct Sequencer {
    pub patterns: Patterns,
    pub arrangement: Arrangement,
}

impl Sequencer {
    /// Hands each note the next `frames` frames pass in a clip to its node, up to [`NOTE_BUDGET`], and holds it down
    /// until its end, or its clip's, its round's or the loop's if one comes first: a note never sounds over its own next
    /// press. A clip goes round its pattern every period from its offset, the notes from the period on never heard. A clip
    /// of a pattern that is gone, and a note of a node that is gone, play nothing. Then lets go of the notes whose end the
    /// frames pass, and of every one of another play or while the transport stands. Returns how many notes found no
    /// room: in the budget, among the held, or in their node's block.
    pub(crate) fn hand_out(
        &self,
        held: &mut Held,
        transport: &Transport,
        graph: &mut Graph,
        frames: usize,
    ) -> usize {
        let (mut left, mut lost) = (NOTE_BUDGET, 0);
        let play = transport.play().unwrap_or(0);
        let loop_ticks = transport.loop_ticks().unwrap_or(0);
        for stretch in transport.stretches(frames) {
            for clip in self.arrangement.playing(stretch.first, stretch.last) {
                let Some(pattern) = self.patterns.get(clip.pattern) else {
                    continue;
                };
                // The ticks of the stretch the clip plays, counted from the start of the round it starts in.
                let (offset, period) = (u64::from(clip.offset), u64::from(clip.period));
                let (first, last) = (
                    u64::from(stretch.first.max(clip.tick) - clip.tick) + offset,
                    u64::from(stretch.last.min(clip.last) - clip.tick) + offset,
                );
                // Each round of the pattern the stretch passes; a stretch is a few ticks long.
                for round in first / period..=last / period {
                    let start = round * period;
                    // Both under the period, so within the pattern's ticks.
                    let passed = pattern.between(
                        within(first.max(start) - start),
                        within(last.min(start + period - 1) - start),
                    );
                    let (handed, over) = passed.split_at(passed.len().min(left));
                    left -= handed.len();
                    lost += over.len();
                    // The tick of the loop the round ends at, past the clip's end as it may be.
                    let round_end = u64::from(clip.tick) + start + period - offset;
                    for note in handed {
                        // From the clip's start, as the note is in the stretch: within the loop.
                        let tick = clip.tick + within(start + u64::from(note.tick) - offset);
                        let Some(node) = graph.node_mut(note.node) else {
                            continue;
                        };
                        let id = held.next_note();
                        if held.notes.len() == HELD_ROOM
                            || node
                                .note_on(stretch.frame(tick), note.key, note.velocity, id)
                                .is_err()
                        {
                            lost += 1;
                            continue;
                        }
                        let length = u64::from(note.length)
                            .min(u64::from(loop_ticks - tick))
                            .min(u64::from(clip.last - tick) + 1)
                            .min(round_end - u64::from(tick));
                        held.notes.push(HeldNote {
                            node: note.node,
                            note: id,
                            play,
                            until: Some(stretch.count(tick) + length),
                        });
                    }
                }
            }
        }
        held.let_go(transport, graph, frames);
        lost
    }
}

/// The pattern's notes pressed and not yet let go of. Not part of a session: a note outlives the pattern that pressed
/// it, and a reset's nodes are gone, which lets go of theirs.
#[derive(Debug)]
pub(crate) struct Held {
    notes: Vec<HeldNote>,
    /// Names the next note pressed, from [`PAGE_NOTES`] up: the page's notes lie below.
    next: u32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct HeldNote {
    node: NodeHandle,
    /// As its `NoteOn` named it.
    note: NoteId,
    /// The start of play it was pressed in: its end counts from that one's start.
    play: u32,
    /// The count from the start of play of the tick it is let go of at; none to be let go of at once.
    until: Option<u64>,
}

impl Held {
    /// Allocates, so only before the audio thread starts.
    pub(crate) fn new() -> Self {
        Self {
            notes: Vec::with_capacity(HELD_ROOM),
            next: 0,
        }
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.notes.len()
    }

    /// Every note the nodes hold, at the next block's start; `nodes` are sorted.
    pub(crate) fn let_go_of(&mut self, nodes: &[NodeHandle]) {
        for held in self
            .notes
            .iter_mut()
            .filter(|held| nodes.binary_search(&held.node).is_ok())
        {
            held.until = None;
        }
    }

    /// Wraps around within the pattern's half: a note held through two billion others is long gone.
    fn next_note(&mut self) -> NoteId {
        let note = PAGE_NOTES | self.next;
        self.next = (self.next + 1) % PAGE_NOTES;
        NoteId::new(note)
    }

    /// A note whose node has no room left in the block waits for the next; one whose node is gone is dropped.
    fn let_go(&mut self, transport: &Transport, graph: &mut Graph, frames: usize) {
        let play = transport.play();
        let run = transport.run(frames);
        self.notes.retain(|held| {
            let frame = match (held.until, run) {
                _ if play != Some(held.play) => 0,
                (None, _) => 0,
                // Its end went by in a block that had no room for it.
                (Some(until), Some(run)) if until < run.first => 0,
                (Some(until), Some(run)) if until <= run.last => run.frame(until),
                _ => return true,
            };
            graph
                .node_mut(held.node)
                .is_some_and(|node| node.note_off(frame, held.note).is_err())
        });
    }
}

#[cfg(test)]
mod tests;
