//! Frames a caller already holds.
//!
//! The other implementation of [`Samples`] is the worklet's, over the shared
//! region. This one is for everything outside it: the offline render, and the
//! interface handing over what it decoded.

use crate::Samples;

/// Interleaved samples borrowed from wherever they were decoded.
///
/// Borrowed rather than owned: this crate is `no_std` and has no allocator to
/// own them with.
pub struct Frames<'a> {
    samples: &'a [f32],
    channels: usize,
}

impl<'a> Frames<'a> {
    /// `samples` interleaved, the way a buffer holds them — the channels of one
    /// frame are neighbours.
    #[must_use]
    pub const fn new(samples: &'a [f32], channels: usize) -> Self {
        Self { samples, channels }
    }
}

impl Samples for Frames<'_> {
    fn frames(&self) -> usize {
        match self.channels {
            0 => 0,
            channels => self.samples.len() / channels,
        }
    }

    fn channels(&self) -> usize {
        self.channels
    }

    fn sample(&self, frame: usize, channel: usize) -> f32 {
        // Without this a channel past the end reads the next frame's, which is
        // a sample where the trait promises silence — and the region's
        // implementation answers silence, so the two would disagree.
        if channel >= self.channels {
            return 0.0;
        }

        // Checked, because the indices are a caller's and the trait is total.
        frame
            .checked_mul(self.channels)
            .and_then(|at| at.checked_add(channel))
            .and_then(|at| self.samples.get(at))
            .copied()
            .unwrap_or(0.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Interleaved: the channels of one frame are neighbours, and one channel
    /// of two frames is a stride apart. Every value differs from every other,
    /// so a mistake in that arithmetic reads back some other sample.
    #[test]
    fn a_frame_holds_its_channels_side_by_side() {
        let source = [1.0, 2.0, 3.0, 4.0];
        let frames = Frames::new(&source, 2);

        assert_eq!(frames.frames(), 2);
        assert_eq!(frames.channels(), 2);
        assert_eq!(frames.sample(0, 0), 1.0);
        assert_eq!(frames.sample(0, 1), 2.0);
        assert_eq!(frames.sample(1, 0), 3.0);
        assert_eq!(frames.sample(1, 1), 4.0);
    }

    /// A trailing sample that does not complete a frame is not a frame.
    #[test]
    fn a_frame_count_is_what_the_channels_divide_into() {
        let source = [1.0, 2.0, 3.0, 4.0, 5.0];
        assert_eq!(Frames::new(&source, 2).frames(), 2);
    }

    /// Silence rather than the next frame's first sample, which is what the
    /// arithmetic alone would have answered.
    #[test]
    fn a_channel_past_the_end_is_silence_and_not_the_next_frame() {
        let source = [1.0, 2.0, 3.0, 4.0];
        let frames = Frames::new(&source, 2);

        assert_eq!(frames.sample(0, 2), 0.0);
        assert_eq!(
            frames.sample(0, 1),
            2.0,
            "the channel before it still reads"
        );
    }

    #[test]
    fn a_frame_past_the_end_is_silence() {
        let source = [1.0, 2.0];
        assert_eq!(Frames::new(&source, 1).sample(2, 0), 0.0);
    }

    /// A source of no channels has no frames and no samples, rather than a
    /// division by zero.
    #[test]
    fn a_source_of_no_channels_is_empty() {
        let source = [1.0, 2.0];
        let frames = Frames::new(&source, 0);

        assert_eq!(frames.frames(), 0);
        assert_eq!(frames.sample(0, 0), 0.0);
    }

    /// Indices arrive from a caller, so the arithmetic that turns two of them
    /// into one must not wrap into a sample that is really there.
    #[test]
    fn an_index_that_overflows_the_arithmetic_is_silence() {
        let source = [1.0, 2.0];
        assert_eq!(Frames::new(&source, 2).sample(usize::MAX, 1), 0.0);
    }
}
