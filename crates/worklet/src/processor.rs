//! One quantum's worth of work: take what the interface asked for, render it,
//! say what happened.
//!
//! Kept apart from the statics in `lib.rs` and given its memory rather than
//! reaching for it, so that the same code runs under `cargo test` on the host
//! over an ordinary allocation. The protocol had never crossed the boundary it
//! exists for; this is the half of that which does not need a browser.

use escapement_core::Engine;
use escapement_protocol::{
    AudioLayout, Command, CommandKind, Consumer, EngineState, Layout, Pointers, Publisher,
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
    pub(crate) fn process(&mut self, out: &mut [f32]) {
        self.take_commands();
        self.engine.process(self.samples.as_ref(), out);
        self.quanta = self.quanta.wrapping_add(1);

        self.state.publish(&EngineState {
            clock: self.engine.clock(),
            quanta: self.quanta,
            peak: peak(out),
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
            CommandKind::Start => self.engine.start(),
            CommandKind::Stop => self.engine.stop(),
            CommandKind::SetFrequency(hz) => self.engine.set_frequency(hz),
            CommandKind::SetGain(gain) => self.engine.set_gain(gain),
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
    use core::marker::PhantomData;
    use core::sync::atomic::AtomicU32;

    use escapement_core::RENDER_QUANTUM;
    use escapement_protocol::{Cells, Full, Producer, Subscriber};

    use super::*;
    // Explicit, so it wins over the glob above: `super` has the layout that
    // ships, and every test here wants the one a region can be allocated of.
    use crate::fixtures::{cells, words, LAYOUT};

    fn rate() -> SampleRate {
        SampleRate::new(48_000.0).expect("48 kHz is a rate")
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

        fn quantum(&mut self) -> [f32; RENDER_QUANTUM] {
            let mut block = [0.0f32; RENDER_QUANTUM];
            self.processor.process(&mut block);
            block
        }

        fn state(&self) -> EngineState {
            self.watcher.read().expect("the writer was not in the way")
        }
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
        probe.send(CommandKind::Start).unwrap();

        assert!(peak(&probe.quantum()) > 0.0);
    }

    #[test]
    fn the_transport_can_be_stopped_again() {
        let words = words();
        let mut probe = Probe::new(&words);
        probe.send(CommandKind::Start).unwrap();
        probe.quantum();

        probe.send(CommandKind::Stop).unwrap();
        assert_eq!(peak(&probe.quantum()), 0.0);
        assert!(!probe.state().playing);
    }

    #[test]
    fn the_state_describes_the_quantum_that_was_just_rendered() {
        let words = words();
        let mut probe = Probe::new(&words);
        probe.send(CommandKind::Start).unwrap();
        probe.send(CommandKind::SetGain(1.0)).unwrap();
        let block = probe.quantum();

        let state = probe.state();
        assert_eq!(state.clock, RENDER_QUANTUM as u64);
        assert_eq!(state.quanta, 1);
        assert_eq!(state.peak, peak(&block));
        assert!(state.playing);
        assert_eq!(state.commands_applied, 2);
        assert_eq!(state.commands_unknown, 0);
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
        probe.send(CommandKind::Unknown(4242)).unwrap();
        probe.send(CommandKind::Start).unwrap();

        assert!(
            peak(&probe.quantum()) > 0.0,
            "the unknown one stopped the rest"
        );

        let state = probe.state();
        assert_eq!(state.commands_unknown, 1);
        assert_eq!(
            state.commands_applied, 2,
            "an unknown command still left the ring"
        );
    }

    /// Its length is the caller's, so the offline render for export can drive
    /// this in blocks of its own — which is the difference between `clock` and
    /// `quanta` that the state block claims to carry.
    #[test]
    fn a_block_that_is_not_a_render_quantum_moves_the_clock_by_its_own_length() {
        let words = words();
        let mut probe = Probe::new(&words);
        let mut long = vec![0.0f32; 1024];
        probe.processor.process(&mut long);

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

        probe
            .send(CommandKind::SetGain(1.0))
            .expect("an empty ring");
        probe.send(CommandKind::Start).expect("an empty ring");
        probe.publish(1, &[0.5; 8], 1).expect("an empty ring");

        let block = probe.quantum();
        assert_eq!(block[..8], [0.5; 8], "the frames were not found");
        assert_eq!(peak(&block[8..]), 0.0, "the source ran past its end");
    }

    /// The number the interface sent comes back, which is what lets it know
    /// the engine has moved on to the words that publication named — and, a
    /// buffer with two halves in it, that the other half is free again.
    #[test]
    fn an_accepted_publication_is_echoed_to_the_interface() {
        let words = words();
        let mut probe = Probe::new(&words);

        assert_eq!(probe.state().audio_publication, 0, "nothing published yet");

        probe.send(CommandKind::Start).expect("an empty ring");
        probe.publish(7, &[0.5; 8], 1).expect("an empty ring");
        probe.quantum();

        assert_eq!(probe.state().audio_publication, 7);
    }

    /// A descriptor crosses a memory the interface also writes to, so one
    /// naming more than the buffer holds is a shape this side has to answer
    /// for. It answers by refusing it, which leaves the oscillator playing —
    /// and the point of the test is that the answer is not a read outside the
    /// region.
    #[test]
    fn a_descriptor_larger_than_the_buffer_is_refused() {
        let words = words();
        let mut probe = Probe::new(&words);

        probe.send(CommandKind::Start).expect("an empty ring");
        probe
            .send(CommandKind::Audio {
                publication: 1,
                offset: 0,
                frames: u32::MAX,
                channels: 2,
            })
            .expect("an empty ring");

        assert!(
            peak(&probe.quantum()) > 0.0,
            "the engine went silent rather than staying on the oscillator"
        );
        assert_eq!(
            probe.state().audio_publication,
            0,
            "a refused descriptor was echoed as if it had been taken"
        );
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

        probe
            .send(CommandKind::SetGain(1.0))
            .expect("an empty ring");
        probe.send(CommandKind::Start).expect("an empty ring");
        probe.publish(1, &[0.5; 8], 1).expect("an empty ring");
        probe.quantum();

        probe
            .send(CommandKind::Audio {
                publication: 2,
                offset: 0,
                frames: u32::MAX,
                channels: 2,
            })
            .expect("an empty ring");
        probe.send(CommandKind::Start).expect("an empty ring");

        let block = probe.quantum();
        assert_eq!(block[..8], [0.5; 8], "the frames that played were dropped");
        assert_eq!(
            probe.state().audio_publication,
            1,
            "the refused publication was echoed"
        );
    }
}
