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
