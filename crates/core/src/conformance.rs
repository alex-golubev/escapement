//! The contract [`Samples`] states in prose, in a form that runs.
//!
//! There are two implementations and a third is coming, when frames stream from
//! a worker instead of sitting in a buffer (ARCHITECTURE.md §5). Each one's
//! tests were written beside it, out of the same paragraph — and the argument
//! for guarding both indices was made in one of them and never reached the
//! other. This is that argument in a form neither can be written without.
//!
//! `#[doc(hidden)] pub` rather than a cargo feature: features are unified across
//! a workspace build, so one here would be on in the worklet's copy of this
//! crate too (`.claude/rules/protocol.md`). Nothing below reaches a module that
//! does not call it — a generic function nobody instantiates emits no code.

#![allow(
    clippy::indexing_slicing,
    reason = "the contract's own reading of what it was handed: an index out of \
              range here is a test failing, and nothing below is instantiated \
              outside one"
)]

use crate::Samples;

/// Asserts the whole of [`Samples`] against `over`, which the caller built over
/// `values` as frames of `channels` channels.
///
/// Hand it a `values` whose length `channels` does not divide: past the last
/// whole frame there is then a sample to be read, and reading it is the failure
/// this exists to catch.
///
/// # Panics
///
/// On the first disagreement, naming the indices it was at.
pub fn check<S: Samples>(over: &S, values: &[f32], channels: usize) {
    let frames = values.len().checked_div(channels).unwrap_or(0);

    assert_eq!(over.channels(), channels, "channels");
    assert_eq!(over.frames(), frames, "whole frames of {channels} channels");

    // Interleaved: the channels of one frame are neighbours, and one channel of
    // two frames is a stride apart. Every value the callers pass differs from
    // every other, so a mistake in that arithmetic reads back some other sample
    // rather than the one it wanted.
    for frame in 0..frames {
        for channel in 0..channels {
            assert_eq!(
                over.sample(frame, channel),
                values[frame * channels + channel],
                "frame {frame}, channel {channel}"
            );
        }
    }

    assert_eq!(
        over.sample(frames, 0),
        0.0,
        "a frame past the end, where a trailing sample may still be sitting"
    );
    assert_eq!(
        over.sample(0, channels),
        0.0,
        "a channel that is not there, whose index is the next frame's first"
    );
    assert_eq!(
        over.sample(usize::MAX, channels.saturating_sub(1)),
        0.0,
        "an index the arithmetic behind it would wrap on"
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A source that answers the arithmetic instead of the contract: past the
    /// last whole frame there is a sample in the slice and this hands it over.
    /// The mistake `Frames` carried until the suite above existed.
    struct PastTheEnd<'a> {
        samples: &'a [f32],
        channels: usize,
    }

    impl Samples for PastTheEnd<'_> {
        fn frames(&self) -> usize {
            self.samples.len() / self.channels
        }

        fn channels(&self) -> usize {
            self.channels
        }

        fn sample(&self, frame: usize, channel: usize) -> f32 {
            self.samples
                .get(frame * self.channels + channel)
                .copied()
                .unwrap_or(0.0)
        }
    }

    /// The suite has to fail something. A `check` that asserts nothing is one
    /// every implementation passes, and the two it holds together would drift
    /// underneath it with every test still green — which is the whole of what
    /// it was written to stop.
    #[test]
    #[should_panic(expected = "a frame past the end")]
    fn an_implementation_that_reads_past_its_last_frame_is_caught() {
        let samples = [1.0, 2.0, 3.0, 4.0, 5.0];
        let over = PastTheEnd {
            samples: &samples,
            channels: 2,
        };

        check(&over, &samples, 2);
    }
}
