//! Everything behind the entry points: the engine, and what happens before
//! there is an engine at all.
//!
//! Apart from the statics in `lib.rs` and handed its memory rather than
//! reaching for it, for the reason `processor.rs` gives one layer down — but
//! here the reason is sharper. A `static` exists once per process and
//! [`Module::init`] cannot be undone, so behaviour left in `lib.rs` is
//! behaviour a test can reach once and never again: the silence below was
//! unreachable by every test in this crate until it moved here.

use escapement_protocol::{Layout, Pointers};
use escapement_time::SampleRate;

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
    ///
    /// A rate that is not one leaves the module without an engine and therefore
    /// without a header. The number comes from the host rather than from this
    /// program, and the magic is the promise that something is rendering behind
    /// it: silence behind a good header is indistinguishable from a stopped
    /// transport, while a handshake that never completes says where to look. The
    /// other side already has a word for that (`HandshakeError::Magic`), and no
    /// word for "the engine was built on a rate of NaN".
    pub(crate) fn init(&mut self, cells: Pointers, layout: Layout, sample_rate_hz: f32) {
        let Some(rate) = SampleRate::new(f64::from(sample_rate_hz)) else {
            return;
        };
        self.engine = Some(Processor::new(cells, layout, rate));
    }

    /// One quantum into each channel, and both are overwritten either way.
    ///
    /// Silence until [`Module::init`] has run. A missed init must not be a
    /// panic on the audio thread — and it must not be the previous quantum
    /// either, because the host reads this block whether or not anything wrote
    /// to it.
    pub(crate) fn process(&mut self, left: &mut [f32], right: &mut [f32]) {
        match self.engine.as_mut() {
            Some(engine) => engine.process(left, right),
            None => {
                left.fill(0.0);
                right.fill(0.0);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use escapement_core::RENDER_QUANTUM;
    use escapement_protocol::{Cells, Command, CommandKind, HandshakeError, Producer};
    use escapement_time::tempo::Curve;
    use escapement_time::{Position, Span};

    use super::*;
    use crate::fixtures::{cells, words, LAYOUT};

    const RATE: f32 = 48_000.0;

    /// What has to be said before a started transport is audible: a tempo, a
    /// clip, and the frames it reads. Spelled once here and once in `lib.rs`,
    /// which are the two places that drive the module rather than the
    /// processor.
    fn scene(frames: u32) -> [CommandKind; 4] {
        [
            CommandKind::SetTempo {
                beats_per_minute: 120.0,
                curve: Curve::Hold,
            },
            CommandKind::PlaceClip {
                start: Position::ZERO,
                length: Span::quarters(64),
                trim: 0,
            },
            CommandKind::Audio {
                publication: 1,
                offset: 0,
                frames,
                channels: 1,
            },
            CommandKind::Start { at: Position::ZERO },
        ]
    }

    /// The case no test in this crate could reach while it lived in `lib.rs`:
    /// there, `init` had already run by the time anything could look, and it
    /// cannot be undone.
    #[test]
    fn a_module_with_no_engine_renders_silence() {
        // Dirtied first. A block that starts at zero cannot say whether the
        // silence in it was produced or merely never overwritten, which is
        // exactly the mistake this guards.
        let mut left = [0.5f32; RENDER_QUANTUM];
        let mut right = [0.5f32; RENDER_QUANTUM];

        Module::new().process(&mut left, &mut right);

        assert!(
            left.iter().chain(right.iter()).all(|sample| *sample == 0.0),
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

        Module::new().init(cells(&words), LAYOUT, RATE);

        assert_eq!(Layout::read_header(&cells(&words)), Ok(LAYOUT));
    }

    /// The host's number, and the one case where it is not a rate. Silence and
    /// no header, rather than an engine dividing by it — and every value
    /// separately, since one guard covering three of four passes a test that
    /// tries only the fourth.
    #[test]
    fn a_rate_that_is_not_one_leaves_the_module_without_an_engine() {
        for bad in [f32::NAN, f32::INFINITY, 0.0, -RATE] {
            let words = words();
            let mut module = Module::new();
            module.init(cells(&words), LAYOUT, bad);

            assert_eq!(
                Layout::read_header(&cells(&words)),
                Err(HandshakeError::Magic { found: 0 }),
                "{bad} was promised an engine"
            );

            let mut left = [0.5f32; RENDER_QUANTUM];
            let mut right = [0.5f32; RENDER_QUANTUM];
            module.process(&mut left, &mut right);
            assert!(
                left.iter().chain(right.iter()).all(|sample| *sample == 0.0),
                "{bad} left the previous quantum in the block"
            );
        }
    }

    /// That an initialized module renders through the engine rather than down
    /// the silence path above.
    #[test]
    fn a_started_transport_reaches_the_block() {
        let words = words();
        let mut module = Module::new();
        module.init(cells(&words), LAYOUT, RATE);

        let seen = Layout::read_header(&cells(&words)).expect("init wrote a header");
        let held = cells(&words);
        let frames = seen.audio().words();
        for word in 0..frames {
            held.store_relaxed(seen.audio().base() + word, 0.9f32.to_bits());
        }

        let mut interface = Producer::new(cells(&words), seen.commands());
        for kind in scene(frames as u32) {
            interface.push(&Command::now(kind)).unwrap();
        }

        let mut left = [0.0f32; RENDER_QUANTUM];
        let mut right = [0.0f32; RENDER_QUANTUM];
        module.process(&mut left, &mut right);

        assert!(
            left.iter().any(|sample| *sample != 0.0),
            "Start did not reach the block"
        );
    }
}
