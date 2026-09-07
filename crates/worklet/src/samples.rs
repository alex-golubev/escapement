//! The frames in the region, read as sound.
//!
//! Where the two halves meet: `escapement-protocol` says where the frames sit,
//! `escapement-core` says what a source is, and neither may name the other
//! (ARCHITECTURE.md §3). This is the same seam the command decode sits on — the
//! wire on one side, the engine on the other, and the translation here.

use escapement_core::Samples;
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
    /// `None` for a descriptor naming more than the buffer holds.
    ///
    /// Checked rather than trusted, for the reason `Layout::read_header`
    /// checks the header: it crossed a memory the other half also writes to,
    /// and further in there is nothing to report an error to. Refusing it here
    /// leaves the engine on the oscillator, which is audible.
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
