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
    /// Worked out once, so that [`Samples::sample`] guards on a field the way
    /// the region's implementation does rather than on a division.
    frames: usize,
}

impl<'a> Frames<'a> {
    /// `samples` interleaved, the way a buffer holds them — the channels of one
    /// frame are neighbours.
    #[must_use]
    pub const fn new(samples: &'a [f32], channels: usize) -> Self {
        // No channels is no frames rather than a division by zero.
        let frames = match samples.len().checked_div(channels) {
            Some(frames) => frames,
            None => 0,
        };

        Self {
            samples,
            channels,
            frames,
        }
    }
}

impl Samples for Frames<'_> {
    fn frames(&self) -> usize {
        self.frames
    }

    fn channels(&self) -> usize {
        self.channels
    }

    fn sample(&self, frame: usize, channel: usize) -> f32 {
        // Both indices, because a guard on either one alone lets the other
        // through: a channel past the end reads the next frame's first sample,
        // and a frame past the end reads a trailing one no whole frame covers.
        // The region's implementation answers silence to both, and a
        // disagreement here is the two render paths disagreeing.
        if frame >= self.frames || channel >= self.channels {
            return 0.0;
        }

        // In bounds, and past overflow, from the guard alone: the frame count
        // is the length divided by the channels, so the largest index it admits
        // is the last one there is. `get` rather than an index because the
        // trait is total and this is reached from the audio thread, where a
        // panic is the one thing there is no answer to.
        self.samples
            .get(frame * self.channels + channel)
            .copied()
            .unwrap_or(0.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::conformance;

    /// The whole of [`Samples`], over lengths the channel count does not
    /// divide: past the last whole frame there is a sample sitting in the
    /// slice, and reading it is what the region's implementation never does.
    #[test]
    fn a_slice_holds_the_samples_contract() {
        for (source, channels) in [
            (&[1.0, 2.0, 3.0, 4.0, 5.0][..], 1),
            (&[1.0, 2.0, 3.0, 4.0, 5.0][..], 2),
            (&[1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0][..], 3),
        ] {
            conformance::check(&Frames::new(source, channels), source, channels);
        }
    }

    /// A source of no channels has no frames and no samples, rather than a
    /// division by zero.
    #[test]
    fn a_source_of_no_channels_is_empty() {
        let source = [1.0, 2.0];
        conformance::check(&Frames::new(&source, 0), &source, 0);
    }
}
