//! One quantum's worth of work: take what the interface asked for, render it,
//! say what happened.
//!
//! Kept apart from the statics in `lib.rs` and given its memory rather than
//! reaching for it, so that the same code runs under `cargo test` on the host
//! over an ordinary allocation. The protocol had never crossed the boundary it
//! exists for; this is the half of that which does not need a browser.

use escapement_core::{Engine, Stage};
use escapement_protocol::{
    AudioLayout, Command, CommandKind, Consumer, EngineState, Layout, Pointers, Publisher,
    Stage as WireStage,
};
use escapement_time::SampleRate;

use crate::samples::Published;

/// Slots in the command ring.
///
/// Sized for a burst, not for a quantum (§3): a frame's worth of commands plus
/// whatever the engine has not taken yet, and loading a project is the case
/// that fills it. 256 slots is 8 KiB of a 32 MiB memory.
pub(crate) const COMMAND_SLOTS: u32 = 256;

/// Words in the audio buffer: 4 MiB of a 32 MiB memory, which at 48 kHz holds
/// about eleven seconds of stereo or twice that in mono.
///
/// A loop rather than a song, and deliberately: this buffer is slice 1 standing
/// in for streaming, and what replaces it reads from OPFS through a worker (§5)
/// instead of holding the whole of anything. Sized here rather than in the
/// protocol because it is a fact about this module's memory — the protocol
/// describes whatever it is told, and the header is what tells the other side.
pub(crate) const AUDIO_WORDS: usize = 1 << 20;

// A second of stereo at 48 kHz, which is the least this is worth having at.
// Here rather than in a test because every test builds its region from the
// fixtures' layout instead, so nothing over there would notice a buffer of no
// words at all — a region that still builds, a header that still reads back,
// and an engine that can never be given a frame.
//
// No ceiling beside it: `build.rs` links the memory and
// `tools/check-shared-memory.py` reads it back, and a copy of that number here
// would be a second thing to keep true.
const _: () = assert!(AUDIO_WORDS >= 48_000 * 2);

/// Where the header, the ring, the state block and the frames sit. `const`, so
/// a capacity that is not a power of two, or a region above the protocol's
/// ceiling, is a compile error rather than a panic on the audio thread.
pub(crate) const LAYOUT: Layout = Layout::new(COMMAND_SLOTS, AUDIO_WORDS);

/// Commands applied per quantum.
///
/// A different number from the capacity above and for a different reason: this
/// one is the audio budget. Draining "everything waiting" would put an
/// unbounded operation inside a 2.7 ms window — the same objection that keeps
/// `memory.grow` off this thread (§1) — and the bound has to be a constant here
/// rather than whatever the other thread happened to push.
///
/// Sixteen leaves the ceiling well above the traffic: six quanta pass per frame
/// at 48 kHz, so the interface would have to send ninety-six commands in one
/// frame to feel it, and a full ring still clears in sixteen quanta, or 43 ms.
const COMMANDS_PER_QUANTUM: usize = 16;

/// The Rust half of the `AudioWorkletProcessor`.
pub(crate) struct Processor {
    engine: Engine,
    commands: Consumer<Pointers, Command>,
    state: Publisher<Pointers>,
    /// Kept as well as handed to the two above, because a descriptor names a
    /// place in this memory and the frames have to be read from somewhere.
    cells: Pointers,
    /// Where in it. The ceiling a descriptor is checked against.
    audio: AudioLayout,
    /// What the interface last published, or nothing it could publish. `None`
    /// leaves the engine on the oscillator (`escapement-core`).
    samples: Option<Published<Pointers>>,
    /// Which publication those frames came from, echoed to the interface.
    ///
    /// Zero until one has been accepted, and left where it is by one that was
    /// not — which is the whole of how a refusal is reported, and what tells
    /// the interface that the words it published last are still being read
    /// (§3).
    publication: u32,
    quanta: u64,
    applied: u32,
    unknown: u32,
}

impl Processor {
    /// Writes the header into `cells`, which must be a region of at least
    /// `layout.words()` words that nothing else has touched.
    ///
    /// Nothing may read the region until this returns: the magic goes down last
    /// and with release ordering, and it is what the other side waits for.
    ///
    /// The layout is handed in rather than reached for, which is the same
    /// argument as the memory it describes. What ships is [`LAYOUT`]; a test
    /// that had to allocate one of those would be allocating four megabytes of
    /// atomics per test, and Miri would then walk them one at a time.
    pub(crate) fn new(cells: Pointers, layout: Layout, rate: SampleRate) -> Self {
        layout.write_header(&cells);

        Self {
            engine: Engine::new(rate),
            commands: Consumer::new(cells, layout.commands()),
            state: Publisher::new(cells, layout.state()),
            audio: layout.audio(),
            cells,
            samples: None,
            publication: 0,
            quanta: 0,
            applied: 0,
            unknown: 0,
        }
    }

    /// Overwrites every element of `out`.
    ///
    /// The order is the point. Commands first, so one that arrived between
    /// quanta takes effect at the start of this one rather than the next, and
    /// on a boundary rather than wherever it landed. State last, so what is
    /// published describes the block that was just rendered — publish first and
    /// the meter shows the previous quantum's peak beside this quantum's clock,
    /// which is telemetry disagreeing with itself.
    pub(crate) fn process(&mut self, left: &mut [f32], right: &mut [f32]) {
        self.take_commands();
        self.engine.process(self.samples.as_ref(), left, right);
        self.quanta = self.quanta.wrapping_add(1);

        self.state.publish(&EngineState {
            clock: self.engine.clock(),
            quanta: self.quanta,
            position: self.engine.position().samples(),
            peak: peak(left).max(peak(right)),
            playing: self.engine.playing(),
            commands_applied: self.applied,
            commands_unknown: self.unknown,
            audio_publication: self.publication,
        });
    }

    fn take_commands(&mut self) {
        for _ in 0..COMMANDS_PER_QUANTUM {
            let Some(command) = self.commands.pop() else {
                break;
            };
            self.apply(command);
        }
    }

    /// `command.when` is ignored, as §2.4 says it is until there is a clock to
    /// compare it against. There is one now, but honouring it means a command
    /// that is not due yet has to wait somewhere, and that somewhere is a
    /// preallocated structure this engine has no use for: one oscillator, and
    /// nothing to schedule against a timeline that does not exist. It arrives
    /// with the sequencer.
    fn apply(&mut self, command: Command) {
        match command.kind {
            CommandKind::Start { at } => self.engine.start(at),
            CommandKind::Stop => self.engine.stop(),
            CommandKind::SetStrip {
                stage,
                gain,
                pan,
                mute,
            } => {
                let strip = self.engine.strip(stage_of(stage));
                strip.set_gain(gain);
                strip.set_pan(pan);
                strip.set_mute(mute);
                self.engine.strips_changed();
            }
            CommandKind::SetTempo {
                beats_per_minute,
                curve,
            } => self.engine.set_tempo(beats_per_minute, curve),
            CommandKind::PlaceClip {
                start,
                length,
                trim,
            } => self.engine.place_clip(start, length, u64::from(trim)),
            CommandKind::ClearClip => self.engine.clear_clip(),
            // A descriptor the buffer cannot hold changes nothing: what was
            // playing goes on playing, and the echo stays behind the number the
            // interface sent. Dropping a working source over a bad descriptor
            // would be a silence with nobody to report it to — and the words
            // the old descriptor names are still the engine's until the echo
            // says otherwise.
            CommandKind::Audio {
                publication,
                offset,
                frames,
                channels,
            } => {
                if let Some(samples) =
                    Published::new(self.cells, self.audio, offset, frames, channels)
                {
                    self.samples = Some(samples);
                    self.publication = publication;
                    // Nothing to rewind: where in the source to read is the
                    // clip's answer, worked out from the transport's position
                    // rather than from a cursor the publication would move.
                }
            }
            // Counted rather than refused: the two halves have parted company,
            // and the interface is the only side that can do anything about it.
            CommandKind::Unknown(_) => self.unknown = self.unknown.wrapping_add(1),
        }

        // Everything taken off the ring, unknown included — this counter is how
        // far behind the engine is, not how much of it made sense.
        self.applied = self.applied.wrapping_add(1);
    }
}

/// The wire's stage, as the engine names it.
///
/// Two enums and a function between them, rather than one enum in the crate
/// they share: the protocol's discriminants are its own and are checked at the
/// handshake, and the engine's are the compiler's
/// (`.claude/rules/protocol.md`).
const fn stage_of(stage: WireStage) -> Stage {
    match stage {
        WireStage::Channel => Stage::Channel,
        WireStage::Insert => Stage::Insert,
        WireStage::Master => Stage::Master,
    }
}

/// Full scale, over the block that was just rendered.
///
/// Here rather than in the engine: it is telemetry about what left the module,
/// and the core has no metering concept until it has a mixer to hang one on.
fn peak(block: &[f32]) -> f32 {
    block
        .iter()
        .fold(0.0f32, |loudest, sample| loudest.max(sample.abs()))
}

#[cfg(test)]
mod tests {
    #![allow(
        clippy::indexing_slicing,
        reason = "a test reaching into what it built: an index out of range is \
                  how it fails"
    )]

    use core::marker::PhantomData;
    use core::num::NonZeroUsize;
    use core::sync::atomic::AtomicU32;

    use escapement_core::{Frames, RENDER_QUANTUM};
    use escapement_export::{render_to_wav, wav};
    use escapement_model::asset::Frames as AssetFrames;
    use escapement_model::mixer::{Channel, ChannelSource, Gain, Insert, Pan};
    use escapement_model::playback::Playback;
    use escapement_model::playlist::{Clip, ClipSource, Lane};
    use escapement_model::project::Parts;
    use escapement_model::timeline::{Tempo, Timeline};
    use escapement_model::{Asset, AssetHash, Entropy, Id, Project};
    use escapement_protocol::{Cells, Full, Producer, Stage as WireStage, Subscriber};
    use escapement_time::meter::Meter;
    use escapement_time::tempo::Curve;
    use escapement_time::{Position, Span};

    use super::*;
    // Explicit, so it wins over the glob above: `super` has the layout that
    // ships, and every test here wants the one a region can be allocated of.
    use crate::fixtures::{cells, words, LAYOUT};

    const RATE_HZ: f64 = 48_000.0;
    const TEMPO: f64 = 120.0;
    const SAMPLE: AssetHash = AssetHash::from_bytes([5; 32]);

    fn rate() -> SampleRate {
        SampleRate::new(RATE_HZ).expect("48 kHz is a rate")
    }

    struct Counter(u128);

    impl Entropy for Counter {
        fn next_u128(&mut self) -> u128 {
            self.0 += 1;
            self.0
        }
    }

    /// The document both paths are driven from: one clip, one channel, the
    /// master, at a tempo that makes a quarter half a second.
    fn document(frames: u64) -> Playback {
        let mut entropy = Counter(0);
        let master = Id::mint(&mut entropy);
        let kick: Id<Channel> = Id::mint(&mut entropy);
        let lane: Id<Lane> = Id::mint(&mut entropy);
        let clip = Id::mint(&mut entropy);

        let mut parts = Parts::new("Song".to_owned(), master);
        parts.timeline = Timeline::new(
            Tempo::new(TEMPO, Curve::Hold).expect("a tempo is a tempo"),
            Meter::new(4, 4).expect("four four is a signature"),
        );
        parts.inserts.push((
            master,
            Insert::new("Master".to_owned(), Gain::UNITY, Pan::CENTRE, false),
        ));
        parts.channels.push((
            kick,
            Channel::new(
                "Kick".to_owned(),
                ChannelSource::Sampler(SAMPLE),
                master,
                Gain::UNITY,
                Pan::CENTRE,
                false,
            ),
        ));
        parts.lanes.push((lane, Lane::new("Drums".to_owned())));
        parts.clips.insert(
            clip,
            Clip::new(
                lane,
                Position::ZERO,
                Span::quarters(64),
                ClipSource::Audio {
                    channel: kick,
                    trim: AssetFrames::ZERO,
                },
            ),
        );
        parts.assets.insert(
            SAMPLE,
            Asset::new("kick.wav".to_owned(), AssetFrames::new(frames), rate(), 1)
                .expect("mono is audio"),
        );

        Playback::of(&Project::new(parts), clip)
    }

    /// Both halves over one allocation, reached the way the worklet reaches its
    /// static — `Pointers` is what ships, so the test drives the access path
    /// that ships rather than a stand-in for it.
    struct Probe<'a> {
        processor: Processor,
        interface: Producer<Pointers, Command>,
        watcher: Subscriber<Pointers>,
        /// The region itself, for the one thing that does not go through the
        /// ring: the page writes frames straight into the buffer.
        cells: Pointers,
        /// `Pointers` carries no lifetime — it cannot, the worklet's region
        /// outlives everything — so this is what keeps the borrow checker
        /// holding the words still for as long as the probe can reach them.
        region: PhantomData<&'a [AtomicU32]>,
    }

    impl<'a> Probe<'a> {
        fn new(words: &'a [AtomicU32]) -> Self {
            let cells = cells(words);
            let processor = Processor::new(cells, LAYOUT, rate());

            // Through the header rather than through `LAYOUT`, because that is
            // what the other side has: it is handed an address and reads the
            // rest out of the region.
            let seen = Layout::read_header(&cells).expect("the worklet wrote a header");

            Self {
                processor,
                interface: Producer::new(cells, seen.commands()),
                watcher: Subscriber::new(cells, seen.state()),
                cells,
                region: PhantomData,
            }
        }

        fn send(&mut self, kind: CommandKind) -> Result<(), Full> {
            self.interface.push(&Command::now(kind))
        }

        /// A tempo and a clip covering the whole render, which is what makes a
        /// started transport audible at all: without a map every position
        /// converts at the origin, and without a clip there is nothing to read.
        fn arm(&mut self) -> Result<(), Full> {
            self.send(CommandKind::SetTempo {
                beats_per_minute: TEMPO,
                curve: Curve::Hold,
            })?;
            self.send(CommandKind::PlaceClip {
                start: Position::ZERO,
                length: Span::quarters(64),
                trim: 0,
            })
        }

        /// Puts frames in the buffer and then names them, in that order,
        /// which is the order the page does it in and the whole of what makes
        /// the ring's release enough (§3).
        fn publish(
            &mut self,
            publication: u32,
            samples: &[f32],
            channels: u32,
        ) -> Result<(), Full> {
            let base = LAYOUT.audio().base();
            for (word, sample) in samples.iter().enumerate() {
                self.cells.store_relaxed(base + word, sample.to_bits());
            }

            self.send(CommandKind::Audio {
                publication,
                offset: 0,
                frames: samples.len() as u32 / channels,
                channels,
            })
        }

        fn quantum(&mut self) -> ([f32; RENDER_QUANTUM], [f32; RENDER_QUANTUM]) {
            let mut left = [0.0f32; RENDER_QUANTUM];
            let mut right = [0.0f32; RENDER_QUANTUM];
            self.processor.process(&mut left, &mut right);
            (left, right)
        }

        fn state(&self) -> EngineState {
            self.watcher.read().expect("the writer was not in the way")
        }
    }

    fn peak(block: &[f32]) -> f32 {
        block
            .iter()
            .fold(0.0f32, |top, sample| top.max(sample.abs()))
    }

    /// Loud enough to be heard through a ramp that has only just started.
    fn loud() -> [f32; 64] {
        [0.9; 64]
    }

    /// The whole reason the header is self-describing rather than a pair of
    /// constants: what one half wrote, the other half has to be able to read
    /// back without being compiled against it.
    #[test]
    fn the_header_the_worklet_writes_is_the_one_the_other_side_reads() {
        let words = words();
        let cells = cells(&words);

        let _processor = Processor::new(cells, LAYOUT, rate());

        assert_eq!(Layout::read_header(&cells), Ok(LAYOUT));
    }

    /// Before the first quantum there is nothing published, and an untouched
    /// block reads as a state rather than as an error — the interface may poll
    /// from the moment it has the address.
    #[test]
    fn an_unwritten_state_block_reads_as_a_stopped_engine() {
        let words = words();
        let probe = Probe::new(&words);
        assert_eq!(probe.state(), EngineState::default());
    }

    /// Taken before the block is rendered, not after: a command that arrives
    /// between quanta must not wait for the one after this.
    #[test]
    fn a_command_takes_effect_in_the_quantum_it_was_taken_in() {
        let words = words();
        let mut probe = Probe::new(&words);
        probe.arm().unwrap();
        probe.publish(1, &loud(), 1).unwrap();
        probe
            .send(CommandKind::Start { at: Position::ZERO })
            .unwrap();

        let (left, _) = probe.quantum();
        assert!(peak(&left) > 0.0);
    }

    #[test]
    fn the_transport_can_be_stopped_again() {
        let words = words();
        let mut probe = Probe::new(&words);
        probe.arm().unwrap();
        probe.publish(1, &loud(), 1).unwrap();
        probe
            .send(CommandKind::Start { at: Position::ZERO })
            .unwrap();
        probe.quantum();

        probe.send(CommandKind::Stop).unwrap();
        // Two quanta, because a stop is a fade and the first one after it is
        // the tail of what was playing.
        probe.quantum();
        probe.quantum();

        let (left, right) = probe.quantum();
        assert_eq!(peak(&left), 0.0);
        assert_eq!(peak(&right), 0.0);
        assert!(!probe.state().playing);
    }

    #[test]
    fn the_state_describes_the_quantum_that_was_just_rendered() {
        let words = words();
        let mut probe = Probe::new(&words);
        probe.arm().unwrap();
        probe.publish(1, &loud(), 1).unwrap();
        probe
            .send(CommandKind::Start { at: Position::ZERO })
            .unwrap();
        let (left, right) = probe.quantum();

        let state = probe.state();
        assert_eq!(state.clock, RENDER_QUANTUM as u64);
        assert_eq!(state.quanta, 1);
        assert_eq!(state.peak, peak(&left).max(peak(&right)));
        assert!(state.playing);
        assert_eq!(state.commands_applied, 4);
        assert_eq!(state.commands_unknown, 0);
    }

    /// The other of the two sample counts, carried because the engine alone
    /// knows it: the interface sent a musical position, and what became of it
    /// depends on the map the engine holds.
    #[test]
    fn the_state_carries_where_the_transport_got_to() {
        let words = words();
        let mut probe = Probe::new(&words);
        probe.arm().unwrap();
        probe.publish(1, &loud(), 1).unwrap();
        probe
            .send(CommandKind::Start {
                at: Position::quarters(1),
            })
            .unwrap();
        probe.quantum();

        assert_eq!(
            probe.state().position,
            24_000 + RENDER_QUANTUM as i64,
            "half a second in, plus the quantum just rendered"
        );
    }

    /// The bound is the audio budget, so it has to hold however much is
    /// waiting, and the remainder has to survive to the next quantum rather
    /// than being dropped.
    #[test]
    fn no_more_than_a_quantum_s_worth_of_commands_is_taken() {
        let words = words();
        let mut probe = Probe::new(&words);
        let sent = COMMANDS_PER_QUANTUM + 5;
        for _ in 0..sent {
            probe.send(CommandKind::Stop).unwrap();
        }

        probe.quantum();
        assert_eq!(probe.state().commands_applied, COMMANDS_PER_QUANTUM as u32);

        probe.quantum();
        assert_eq!(probe.state().commands_applied, sent as u32);
    }

    #[test]
    fn a_full_ring_drains_over_successive_quanta() {
        let words = words();
        let mut probe = Probe::new(&words);
        for _ in 0..COMMAND_SLOTS {
            probe.send(CommandKind::Stop).unwrap();
        }
        assert_eq!(
            probe.send(CommandKind::Stop),
            Err(Full),
            "the ring took more than it has"
        );

        let quanta = COMMAND_SLOTS as usize / COMMANDS_PER_QUANTUM;
        for _ in 0..quanta {
            probe.quantum();
        }

        assert_eq!(probe.state().commands_applied, COMMAND_SLOTS);
    }

    /// A half that knows something this one does not is a fact to report, not a
    /// failure to handle: there is nothing useful to do with an error here.
    #[test]
    fn an_unknown_command_is_counted_and_the_quantum_carries_on() {
        let words = words();
        let mut probe = Probe::new(&words);
        probe.arm().unwrap();
        probe.publish(1, &loud(), 1).unwrap();
        probe.send(CommandKind::Unknown(4242)).unwrap();
        probe
            .send(CommandKind::Start { at: Position::ZERO })
            .unwrap();

        let (left, _) = probe.quantum();
        assert!(peak(&left) > 0.0, "the unknown one stopped the rest");

        let state = probe.state();
        assert_eq!(state.commands_unknown, 1);
        assert_eq!(
            state.commands_applied, 5,
            "an unknown command still left the ring"
        );
    }

    /// A stage neither half agrees on is the whole command being unknown: the
    /// alternative is moving a strip somebody meant to leave alone.
    #[test]
    fn a_strip_command_reaches_the_stage_it_named() {
        let words = words();
        let mut probe = Probe::new(&words);
        probe.arm().unwrap();
        probe.publish(1, &loud(), 1).unwrap();
        probe
            .send(CommandKind::SetStrip {
                stage: WireStage::Master,
                gain: 1.0,
                pan: 0.0,
                mute: true,
            })
            .unwrap();
        probe
            .send(CommandKind::Start { at: Position::ZERO })
            .unwrap();

        let (left, right) = probe.quantum();
        assert_eq!(peak(&left), 0.0, "a muted master was audible");
        assert_eq!(peak(&right), 0.0);
    }

    /// Its length is the caller's, so the offline render for export can drive
    /// this in blocks of its own — which is the difference between `clock` and
    /// `quanta` that the state block claims to carry.
    #[test]
    fn a_block_that_is_not_a_render_quantum_moves_the_clock_by_its_own_length() {
        let words = words();
        let mut probe = Probe::new(&words);
        let mut left = vec![0.0f32; 1024];
        let mut right = vec![0.0f32; 1024];
        probe.processor.process(&mut left, &mut right);

        let state = probe.state();
        assert_eq!(state.clock, 1024);
        assert_eq!(state.quanta, 1);
    }

    /// The frames travel as data in a place of their own and only their
    /// description goes through the ring, which is §3's rule about what a ring
    /// carries. What this asks is whether the engine finds them where it was
    /// told they were.
    #[test]
    fn frames_written_into_the_buffer_are_what_is_heard() {
        let words = words();
        let mut probe = Probe::new(&words);
        probe.arm().expect("an empty ring");
        probe.publish(1, &[0.9; 8], 1).expect("an empty ring");
        probe
            .send(CommandKind::Start { at: Position::ZERO })
            .expect("an empty ring");

        let (left, _) = probe.quantum();
        assert!(peak(&left[..8]) > 0.0, "the frames were not found");
        assert_eq!(peak(&left[8..]), 0.0, "the source ran past its end");
    }

    /// The number the interface sent comes back, which is what lets it know
    /// the engine has moved on to the words that publication named — and, a
    /// buffer with two halves in it, that the other half is free again.
    #[test]
    fn an_accepted_publication_is_echoed_to_the_interface() {
        let words = words();
        let mut probe = Probe::new(&words);

        assert_eq!(probe.state().audio_publication, 0, "nothing published yet");

        probe.arm().expect("an empty ring");
        probe.publish(7, &loud(), 1).expect("an empty ring");
        probe.quantum();

        assert_eq!(probe.state().audio_publication, 7);
    }

    /// A descriptor crosses a memory the interface also writes to, so one
    /// naming more than the buffer holds is a shape this side has to answer
    /// for — and the answer must not be a read outside the region.
    #[test]
    fn a_descriptor_larger_than_the_buffer_is_refused() {
        let words = words();
        let mut probe = Probe::new(&words);

        probe.arm().expect("an empty ring");
        probe
            .send(CommandKind::Audio {
                publication: 1,
                offset: 0,
                frames: u32::MAX,
                channels: 2,
            })
            .expect("an empty ring");
        probe
            .send(CommandKind::Start { at: Position::ZERO })
            .expect("an empty ring");

        probe.quantum();
        assert_eq!(
            probe.state().audio_publication,
            0,
            "a refused descriptor was echoed as if it had been taken"
        );
    }

    /// Where in the source to read is the clip's answer, not a cursor's, so a
    /// second file arriving mid-play does not send the transport back.
    #[test]
    fn a_publication_does_not_move_the_transport() {
        let words = words();
        let mut probe = Probe::new(&words);
        probe.arm().expect("an empty ring");
        probe.publish(1, &loud(), 1).expect("an empty ring");
        probe
            .send(CommandKind::Start { at: Position::ZERO })
            .expect("an empty ring");
        probe.quantum();

        probe.publish(2, &[0.25; 64], 1).expect("an empty ring");
        probe.quantum();

        assert_eq!(probe.state().position, 2 * RENDER_QUANTUM as i64);
        assert_eq!(probe.state().audio_publication, 2);
    }

    /// The refusal above with something already playing, which is the case that
    /// costs something: dropping a source that works over a descriptor that
    /// does not would be a silence with nobody to report it to. The echo
    /// staying put is both the report and the interface's permission to leave
    /// those words alone.
    #[test]
    fn a_refused_descriptor_leaves_the_publication_that_is_playing() {
        let words = words();
        let mut probe = Probe::new(&words);

        probe.arm().expect("an empty ring");
        probe.publish(1, &loud(), 1).expect("an empty ring");
        probe
            .send(CommandKind::Audio {
                publication: 2,
                offset: 0,
                frames: u32::MAX,
                channels: 2,
            })
            .expect("an empty ring");
        probe
            .send(CommandKind::Start { at: Position::ZERO })
            .expect("an empty ring");

        let (left, _) = probe.quantum();
        assert!(peak(&left) > 0.0, "the frames that played were dropped");
        assert_eq!(
            probe.state().audio_publication,
            1,
            "the refused publication was echoed"
        );
    }

    const NOTHING: Option<&Frames<'static>> = None;

    /// Samples compared between the two paths. Long enough to cover the ramp a
    /// start walks up and then some, which is the state most likely to notice
    /// how long a block is.
    const COMPARED: usize = 2_048;

    /// Blocks whose boundaries fall nowhere near the quantum's: 7 is odd and
    /// smaller, 300 is larger and shares no factor with 128.
    const OFFLINE_BLOCKS: [usize; 2] = [7, 300];

    fn block(of: usize) -> NonZeroUsize {
        NonZeroUsize::new(of).expect("a block length")
    }

    /// Drives the online path a quantum at a time and gathers both channels.
    fn online(probe: &mut Probe, samples: usize) -> (Vec<f32>, Vec<f32>) {
        let mut left = Vec::new();
        let mut right = Vec::new();

        while left.len() < samples {
            let (block_left, block_right) = probe.quantum();
            left.extend_from_slice(&block_left);
            right.extend_from_slice(&block_right);
        }

        left.truncate(samples);
        right.truncate(samples);
        (left, right)
    }

    /// A published source, played through and then run out. Every sample
    /// differs from every other, so a cursor that slips shows up as a value
    /// rather than as a level.
    ///
    /// Three channels, because that is the arithmetic the two implementations
    /// of `Samples` do differently and the only thing here that reaches it: at
    /// one channel `frame * channels + channel` collapses to `frame`, the
    /// averaging runs once, and a stride read wrongly lands on the right sample
    /// anyway.
    fn material() -> Vec<f32> {
        (1..=63u8).map(|n| f32::from(n) / 63.0).collect()
    }

    /// The claim slice 1 rests on: the offline render is the same engine, so
    /// the same material comes out as the same samples (§7).
    ///
    /// Here rather than in `escapement-export` because the online path is
    /// `Processor` and `Processor` is this crate's. The export crate is a
    /// dependency of these tests alone.
    ///
    /// What it catches is state that depends on the length of a block — which
    /// the mixer now has: a gain ramp and a fade at a stop, both measured in
    /// samples for exactly this reason (`.claude/rules/rt-safety.md`).
    #[test]
    fn the_offline_render_of_a_source_is_the_online_one() {
        let source = material();

        let words = words();
        let mut probe = Probe::new(&words);
        probe.arm().expect("an empty ring");
        probe.publish(1, &source, 3).expect("an empty ring");
        probe
            .send(CommandKind::Start { at: Position::ZERO })
            .expect("an empty ring");
        let (left, right) = online(&mut probe, COMPARED);

        assert!(peak(&left) > 0.0, "the online render was silent");

        for length in OFFLINE_BLOCKS {
            let mut engine = Engine::new(rate());
            engine.set_tempo(TEMPO, Curve::Hold);
            engine.place_clip(Position::ZERO, Span::quarters(64), 0);
            engine.start(Position::ZERO);

            let mut offline_left = vec![0.0f32; COMPARED];
            let mut offline_right = vec![0.0f32; COMPARED];
            escapement_export::render(
                &mut engine,
                Some(&Frames::new(&source, 3)),
                block(length),
                &mut offline_left,
                &mut offline_right,
            );

            assert_eq!(left, offline_left, "left, blocks of {length}");
            assert_eq!(right, offline_right, "right, blocks of {length}");
        }
    }

    /// The whole path the page takes — the document, the ring, the file —
    /// rather than the renderer alone. Both halves are driven from one
    /// projection, which is what makes them agree (D24): the engine is told
    /// what the document says, and the file is rendered from the same value.
    #[test]
    fn the_file_is_what_was_heard() {
        let source = material();
        let playback = document(21);
        let audible = playback.clip().expect("the document plays");

        let words = words();
        let mut probe = Probe::new(&words);
        let tempo = playback.tempo();
        probe
            .send(CommandKind::SetTempo {
                beats_per_minute: tempo.beats_per_minute(),
                curve: tempo.curve(),
            })
            .expect("an empty ring");
        probe
            .send(CommandKind::PlaceClip {
                start: audible.start(),
                length: audible.length(),
                trim: audible.trim().count() as u32,
            })
            .expect("an empty ring");
        for (stage, strip) in [
            (WireStage::Channel, audible.channel()),
            (WireStage::Insert, audible.insert()),
        ] {
            probe
                .send(CommandKind::SetStrip {
                    stage,
                    gain: strip.gain().amplitude(),
                    pan: strip.pan().position(),
                    mute: strip.mute(),
                })
                .expect("an empty ring");
        }
        probe.publish(1, &source, 3).expect("an empty ring");
        probe
            .send(CommandKind::Start { at: Position::ZERO })
            .expect("an empty ring");

        let (left, right) = online(&mut probe, COMPARED);
        assert!(peak(&left) > 0.0, "the online render was silent");

        let file =
            render_to_wav(&playback, &source, 3, RATE_HZ, COMPARED).expect("a rate and a length");
        let (chunks, rest) = file[wav::HEADER_BYTES..].as_chunks::<4>();
        assert!(rest.is_empty(), "a file of whole samples");
        let out: Vec<f32> = chunks.iter().copied().map(f32::from_le_bytes).collect();

        for frame in 0..COMPARED {
            assert_eq!(out[frame * 2], left[frame], "left, frame {frame}");
            assert_eq!(out[frame * 2 + 1], right[frame], "right, frame {frame}");
        }
    }

    /// The engine with nothing published is silence rather than whatever the
    /// block came with, and the offline path says the same.
    #[test]
    fn an_engine_with_nothing_published_renders_silence() {
        let mut engine = Engine::new(rate());
        engine.set_tempo(TEMPO, Curve::Hold);
        engine.place_clip(Position::ZERO, Span::quarters(64), 0);
        engine.start(Position::ZERO);

        let mut left = vec![1.0f32; 256];
        let mut right = vec![1.0f32; 256];
        escapement_export::render(&mut engine, NOTHING, block(64), &mut left, &mut right);

        assert_eq!(peak(&left), 0.0);
        assert_eq!(peak(&right), 0.0);
    }
}
