//! The frames in the region, read as sound.
//!
//! Where the two halves meet: `escapement-protocol` says where the frames sit,
//! `escapement-core` says what a source is, and neither may name the other
//! (ARCHITECTURE.md §3). This is the same seam the command decode sits on — the
//! wire on one side, the engine on the other, and the translation here.

use escapement_core::{Samples, MAX_SOURCE_CHANNELS};
use escapement_protocol::{AudioLayout, Cells};

/// Frames the interface published, behind a descriptor that has been checked
/// against the buffer it names.
pub(crate) struct Published<C> {
    cells: C,
    /// Absolute, so that reading a sample is one addition rather than two.
    base: usize,
    frames: usize,
    channels: usize,
}

impl<C: Cells> Published<C> {
    /// `None` for a descriptor naming more than the buffer holds, or more
    /// channels than a quantum can afford to average.
    ///
    /// Checked rather than trusted, for the reason `Layout::read_header`
    /// checks the header: it crossed a memory the other half also writes to,
    /// and further in there is nothing to report an error to. Refusing it here
    /// leaves the engine playing what it was playing, and the interface reads
    /// that off the echo (§3).
    pub(crate) fn new(
        cells: C,
        layout: AudioLayout,
        offset: u32,
        frames: u32,
        channels: u32,
    ) -> Option<Self> {
        let offset = offset as usize;
        let frames = frames as usize;
        let channels = channels as usize;

        // The buffer's size does not bound this: one frame of very many
        // channels fits in it and still costs a read per channel per sample
        // out.
        if channels > MAX_SOURCE_CHANNELS {
            return None;
        }

        // Checked both times: `usize` is 32 bits on the target, and two numbers
        // out of shared memory multiply to more than it holds long before they
        // reach a comparison that would have turned them away.
        let words = frames.checked_mul(channels)?;
        if offset.checked_add(words)? > layout.words() {
            return None;
        }

        Some(Self {
            // Inside the region, because the sum above put the frames inside
            // the buffer and the layout puts the buffer inside the region.
            base: layout.base() + offset,
            cells,
            frames,
            channels,
        })
    }
}

impl<C: Cells> Samples for Published<C> {
    fn frames(&self) -> usize {
        self.frames
    }

    fn channels(&self) -> usize {
        self.channels
    }

    fn sample(&self, frame: usize, channel: usize) -> f32 {
        if frame >= self.frames || channel >= self.channels {
            return 0.0;
        }

        // Relaxed rather than an ordinary read. The interface writes these
        // words, and a race on a non-atomic access is undefined behaviour in
        // Rust's model even where every value it could return would have been
        // fine (§3). On wasm it is the same load instruction, so this costs
        // nothing at run time.
        //
        // What orders the frames against this read is the ring: they were
        // written before the command that names them was pushed, and the
        // release on its tail is what carries them across.
        f32::from_bits(
            self.cells
                .load_relaxed(self.base + frame * self.channels + channel),
        )
    }
}

#[cfg(test)]
mod tests {
    use escapement_protocol::{Cells, Pointers};

    use super::*;
    use crate::fixtures::{cells, words, LAYOUT};

    /// Puts `values` at the start of the audio buffer, the way the page does.
    fn written(cells: Pointers, values: &[f32]) {
        let base = LAYOUT.audio().base();
        for (word, value) in values.iter().enumerate() {
            cells.store_relaxed(base + word, value.to_bits());
        }
    }

    /// The contract [`Frames`](escapement_core::Frames) is held to, over the
    /// region — and holding both to one suite is the whole of what lets the two
    /// render paths be compared at all.
    ///
    /// Lengths the channel count does not divide, so the word past the last
    /// whole frame is written and must not be read: the case a guard on the
    /// channel index alone lets through.
    #[test]
    fn the_region_holds_the_samples_contract() {
        for (values, channels) in [
            (&[1.0, 2.0, 3.0, 4.0, 5.0][..], 1u32),
            (&[1.0, 2.0, 3.0, 4.0, 5.0][..], 2),
            (&[1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0][..], 3),
        ] {
            let region = words();
            let cells = cells(&region);
            written(cells, values);

            let frames = values.len() as u32 / channels;
            let published = Published::new(cells, LAYOUT.audio(), 0, frames, channels)
                .expect("the fixtures' buffer holds these");

            escapement_core::conformance::check(&published, values, channels as usize);
        }
    }

    /// The offset is words into the buffer and not frames, which is what lets
    /// a second source sit behind the first.
    #[test]
    fn an_offset_is_counted_in_words() {
        let region = words();
        let cells = cells(&region);
        written(cells, &[1.0, 2.0, 3.0]);

        let published = Published::new(cells, LAYOUT.audio(), 2, 1, 1).expect("one frame fits");

        assert_eq!(published.sample(0, 0), 3.0);
    }

    /// What the buffer holds and what a quantum can afford are two ceilings,
    /// and this one is the second: a single frame of `MAX_SOURCE_CHANNELS + 1`
    /// channels fits in the buffer with room to spare and still costs more
    /// reads per block than the budget has.
    #[test]
    fn a_descriptor_of_more_channels_than_a_quantum_affords_is_refused() {
        let region = words();
        let cells = cells(&region);
        let audio = LAYOUT.audio();
        let most = u32::try_from(MAX_SOURCE_CHANNELS).expect("a channel count");

        assert!(
            Published::new(cells, audio, 0, 1, most + 1).is_none(),
            "one channel above the budget"
        );
        assert!(
            Published::new(cells, audio, 0, 1, most).is_some(),
            "exactly the budget"
        );
    }

    /// A descriptor crosses a memory the interface writes to as well, so each
    /// of these arrives as an ordinary afternoon rather than as an attack. Two
    /// of them overflow the arithmetic that would otherwise have caught them,
    /// which is why the sum and the product are both checked.
    #[test]
    fn a_descriptor_the_buffer_cannot_hold_is_refused() {
        let region = words();
        let cells = cells(&region);
        let audio = LAYOUT.audio();
        let room = u32::try_from(audio.words()).expect("a test buffer");

        assert!(
            Published::new(cells, audio, 0, u32::MAX, u32::MAX).is_none(),
            "the product of the two overflows"
        );
        assert!(
            Published::new(cells, audio, u32::MAX, 1, 1).is_none(),
            "the offset overflows the sum"
        );
        assert!(
            Published::new(cells, audio, 0, room, 2).is_none(),
            "twice the room the buffer has"
        );
        assert!(
            Published::new(cells, audio, 0, room, 1).is_some(),
            "exactly the room the buffer has"
        );
    }
}
