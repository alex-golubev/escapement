use std::num::NonZeroUsize;

use escapement_core::{Engine, Samples};

/// Fills `into` by driving `engine` in blocks of `block` samples.
///
/// The last block is whatever is left, which is why the length of `into` needs
/// no relation to `block`.
///
/// The engine arrives already set up — started, and with its gain where the
/// caller wants it. Commands are the worklet's business and there is no ring on
/// this side, so what this can render is a state rather than a session.
pub fn render<S: Samples>(
    engine: &mut Engine,
    source: Option<&S>,
    block: NonZeroUsize,
    into: &mut [f32],
) {
    for chunk in into.chunks_mut(block.get()) {
        engine.process(source, chunk);
    }
}

#[cfg(test)]
mod tests {
    use escapement_core::Frames;
    use escapement_time::SampleRate;

    use super::*;

    const NOTHING: Option<&Frames<'static>> = None;

    fn rate() -> SampleRate {
        SampleRate::new(48_000.0).expect("the tests chose a rate")
    }

    fn block(of: usize) -> NonZeroUsize {
        NonZeroUsize::new(of).expect("a block length")
    }

    fn playing() -> Engine {
        let mut engine = Engine::new(rate());
        engine.set_gain(1.0);
        engine.start();
        engine
    }

    /// A length the block does not divide, so the last block is short and the
    /// tail is rendered rather than left holding what the buffer came with.
    #[test]
    fn a_length_the_block_does_not_divide_is_filled_to_its_end() {
        let mut into = [-1.0f32; 300];
        render(&mut playing(), NOTHING, block(128), &mut into);

        assert_eq!(into.iter().filter(|s| **s == -1.0).count(), 0);
    }

    /// The clock counts the samples asked for and not the blocks they arrived
    /// in, which is the difference the state block carries as `clock` against
    /// `quanta`.
    #[test]
    fn the_clock_moves_by_the_whole_length() {
        let mut engine = playing();
        let mut into = [0.0f32; 300];
        render(&mut engine, NOTHING, block(128), &mut into);

        assert_eq!(engine.clock(), 300);
    }

    /// The property the offline render stands on, at the smallest scale it can
    /// be asked at: one sample at a time against all of it at once.
    ///
    /// The wider version — against the worklet's own 128-sample quanta — is in
    /// `escapement-worklet`, where the online path is.
    #[test]
    fn the_block_length_does_not_reach_the_samples() {
        let mut whole = [0.0f32; 500];
        render(&mut playing(), NOTHING, block(500), &mut whole);

        for length in [1, 7, 128, 499] {
            let mut split = [0.0f32; 500];
            render(&mut playing(), NOTHING, block(length), &mut split);
            assert_eq!(whole, split, "blocks of {length}");
        }
    }

    /// A source is played through rather than restarted at every block, which
    /// is what a player rewound per block would look like.
    #[test]
    fn a_source_carries_across_the_blocks_it_is_rendered_in() {
        let held = [0.1, 0.2, 0.3, 0.4];
        let source = Frames::new(&held, 1);

        let mut into = [0.0f32; 4];
        render(&mut playing(), Some(&source), block(2), &mut into);

        assert_eq!(into, [0.1, 0.2, 0.3, 0.4]);
    }

    /// Rendering past the end of a source is silence, not the last frame held.
    #[test]
    fn a_render_longer_than_its_source_ends_in_silence() {
        let held = [0.5, 0.5];
        let source = Frames::new(&held, 1);

        let mut into = [1.0f32; 6];
        render(&mut playing(), Some(&source), block(4), &mut into);

        assert_eq!(into, [0.5, 0.5, 0.0, 0.0, 0.0, 0.0]);
    }

    /// A buffer of nothing is a render of nothing, rather than one block of
    /// whatever `chunks_mut` would have made of it.
    #[test]
    fn an_empty_buffer_renders_nothing() {
        let mut engine = playing();
        render(&mut engine, NOTHING, block(128), &mut []);

        assert_eq!(engine.clock(), 0);
    }
}
