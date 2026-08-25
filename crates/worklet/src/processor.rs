//! One quantum's worth of work: take what the interface asked for, render it,
//! say what happened.
//!
//! Kept apart from the statics in `lib.rs` and given its memory rather than
//! reaching for it, so that the same code runs under `cargo test` on the host
//! over an ordinary allocation. The protocol had never crossed the boundary it
//! exists for; this is the half of that which does not need a browser.

use escapement_core::Engine;
use escapement_protocol::{
    Command, CommandKind, Consumer, EngineState, Layout, Pointers, Publisher,
};

/// Slots in the command ring.
///
/// Sized for a burst, not for a quantum (§3): a frame's worth of commands plus
/// whatever the engine has not taken yet, and loading a project is the case
/// that fills it. 256 slots is 8 KiB of a 32 MiB memory.
pub(crate) const COMMAND_SLOTS: u32 = 256;

/// Where the header, the ring and the state block sit. `const`, so a capacity
/// that is not a power of two is a compile error rather than a panic on the
/// audio thread.
pub(crate) const LAYOUT: Layout = Layout::new(COMMAND_SLOTS);

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
    quanta: u64,
    applied: u32,
    unknown: u32,
}

impl Processor {
    /// Writes the header into `cells`, which must be a region of at least
    /// [`LAYOUT`]`.words()` words that nothing else has touched.
    ///
    /// Nothing may read the region until this returns: the magic goes down last
    /// and with release ordering, and it is what the other side waits for.
    pub(crate) fn new(cells: Pointers, sample_rate_hz: f32) -> Self {
        LAYOUT.write_header(&cells);

        Self {
            engine: Engine::new(sample_rate_hz),
            commands: Consumer::new(cells, LAYOUT.commands()),
            state: Publisher::new(cells, LAYOUT.state()),
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
        self.engine.process(out);
        self.quanta = self.quanta.wrapping_add(1);

        self.state.publish(&EngineState {
            clock: self.engine.clock(),
            quanta: self.quanta,
            peak: peak(out),
            playing: self.engine.playing(),
            commands_applied: self.applied,
            commands_unknown: self.unknown,
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
    use std::boxed::Box;
    use std::vec::Vec;

    use core::marker::PhantomData;
    use core::sync::atomic::AtomicU32;

    use escapement_core::RENDER_QUANTUM;
    use escapement_protocol::{Full, Producer, Subscriber};

    use super::*;

    const RATE: f32 = 48_000.0;

    /// Both halves over one allocation, reached the way the worklet reaches its
    /// static — `Pointers` is what ships, so the test drives the access path
    /// that ships rather than a stand-in for it.
    struct Probe<'a> {
        processor: Processor,
        interface: Producer<Pointers, Command>,
        watcher: Subscriber<Pointers>,
        /// `Pointers` carries no lifetime — it cannot, the worklet's region
        /// outlives everything — so this is what keeps the borrow checker
        /// holding the words still for as long as the probe can reach them.
        region: PhantomData<&'a [AtomicU32]>,
    }

    /// The words a region sits in. Held by the test rather than by [`Probe`],
    /// and lent to it: a `Box` moved after its pointer was taken is no longer
    /// at the address that pointer holds, which Miri named as undefined
    /// behaviour on the first run of this file. Leaking it instead trades that
    /// for a leak Miri also reports, so the borrow is the answer — and it is
    /// what the worklet has too, where the region is a `static` that outlives
    /// everything reaching it.
    fn words() -> Box<[AtomicU32]> {
        (0..LAYOUT.words()).map(|_| AtomicU32::new(0)).collect()
    }

    impl<'a> Probe<'a> {
        fn new(words: &'a [AtomicU32]) -> Self {
            // SAFETY: `words` is exactly `len` initialized, aligned cells, and
            // the lifetime on `Self` is what keeps them alive and unmoved for
            // as long as this value can reach them.
            let cells = unsafe { Pointers::new(words.as_ptr(), words.len()) };

            let processor = Processor::new(cells, RATE);

            // Through the header rather than through `LAYOUT`, because that is
            // what the other side has: it is handed an address and reads the
            // rest out of the region.
            let seen = Layout::read_header(&cells).expect("the worklet wrote a header");

            Self {
                processor,
                interface: Producer::new(cells, seen.commands()),
                watcher: Subscriber::new(cells, seen.state()),
                region: PhantomData,
            }
        }

        fn send(&mut self, kind: CommandKind) -> Result<(), Full> {
            self.interface.push(&Command::now(kind))
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
        // SAFETY: as in `Probe::new`; `words` outlives this scope's use of it.
        let cells = unsafe { Pointers::new(words.as_ptr(), words.len()) };

        let _processor = Processor::new(cells, RATE);

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
        let mut long: Vec<f32> = std::vec![0.0; 1024];
        probe.processor.process(&mut long);

        let state = probe.state();
        assert_eq!(state.clock, 1024);
        assert_eq!(state.quanta, 1);
    }
}
