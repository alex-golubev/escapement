//! Everything behind the entry points: the engine, and what happens before
//! there is an engine at all.
//!
//! Apart from the statics in `lib.rs` and handed its memory rather than
//! reaching for it, for the reason `processor.rs` gives one layer down — but
//! here the reason is sharper. A `static` exists once per process and
//! [`Module::init`] cannot be undone, so behaviour left in `lib.rs` is
//! behaviour a test can reach once and never again: the silence below was
//! unreachable by every test in this crate until it moved here.

use escapement_protocol::Pointers;

use crate::processor::Processor;

/// The state the `extern "C"` entry points reach, and all of the behaviour
/// behind them.
pub(crate) struct Module {
    engine: Option<Processor>,
}

impl Module {
    /// `const`, because this initializes a `static`.
    pub(crate) const fn new() -> Self {
        Self { engine: None }
    }

    /// Writes the header into `cells` and gives the module an engine.
    ///
    /// Nothing may read `cells` until this returns, and nothing may be handed
    /// its address before that — the magic goes down last, and it is what the
    /// other side waits for.
    pub(crate) fn init(&mut self, cells: Pointers, sample_rate_hz: f32) {
        self.engine = Some(Processor::new(cells, sample_rate_hz));
    }

    /// One quantum, and `out` is overwritten either way.
    ///
    /// Silence until [`Module::init`] has run. A missed init must not be a
    /// panic on the audio thread — and it must not be the previous quantum
    /// either, because the host reads this block whether or not anything wrote
    /// to it.
    pub(crate) fn process(&mut self, out: &mut [f32]) {
        match self.engine.as_mut() {
            Some(engine) => engine.process(out),
            None => out.fill(0.0),
        }
    }
}

#[cfg(test)]
mod tests {
    use core::sync::atomic::AtomicU32;

    use escapement_core::RENDER_QUANTUM;
    use escapement_protocol::{Command, CommandKind, HandshakeError, Layout, Producer};

    use super::*;
    use crate::processor::LAYOUT;

    const RATE: f32 = 48_000.0;

    /// Held by the test rather than by the module: a `Box` moved after its
    /// pointer was taken is no longer at the address that pointer holds, which
    /// Miri named as undefined behaviour the first time this crate was put
    /// under it.
    fn words() -> Box<[AtomicU32]> {
        (0..LAYOUT.words()).map(|_| AtomicU32::new(0)).collect()
    }

    /// `Pointers` is what ships, so the tests reach the region the way the
    /// worklet does rather than through a stand-in.
    fn cells(words: &[AtomicU32]) -> Pointers {
        // SAFETY: `words` is exactly `len` initialized, aligned cells, and the
        // caller holds them still for as long as the value is used.
        unsafe { Pointers::new(words.as_ptr(), words.len()) }
    }

    /// The case no test in this crate could reach while it lived in `lib.rs`:
    /// there, `init` had already run by the time anything could look, and it
    /// cannot be undone.
    #[test]
    fn a_module_with_no_engine_renders_silence() {
        // Dirtied first. A block that starts at zero cannot say whether the
        // silence in it was produced or merely never overwritten, which is
        // exactly the mistake this guards.
        let mut block = [0.5f32; RENDER_QUANTUM];

        Module::new().process(&mut block);

        assert!(
            block.iter().all(|sample| *sample == 0.0),
            "a missed init left the previous quantum in the block"
        );
    }

    #[test]
    fn init_puts_a_header_where_the_other_side_looks_for_one() {
        let words = words();
        assert_eq!(
            Layout::read_header(&cells(&words)),
            Err(HandshakeError::Magic { found: 0 }),
            "a header before anything wrote one"
        );

        Module::new().init(cells(&words), RATE);

        assert_eq!(Layout::read_header(&cells(&words)), Ok(LAYOUT));
    }

    /// That an initialized module renders through the engine rather than down
    /// the silence path above.
    #[test]
    fn a_started_transport_reaches_the_block() {
        let words = words();
        let mut module = Module::new();
        module.init(cells(&words), RATE);

        let seen = Layout::read_header(&cells(&words)).expect("init wrote a header");
        let mut interface = Producer::new(cells(&words), seen.commands());
        interface.push(&Command::now(CommandKind::Start)).unwrap();

        let mut block = [0.0f32; RENDER_QUANTUM];
        module.process(&mut block);

        assert!(
            block.iter().any(|sample| *sample != 0.0),
            "Start did not reach the block"
        );
    }
}
