//! Frames to play, in memory both halves can reach.
//!
//! The one shape §3 describes only in the negative: "a sample buffer or a graph
//! is published elsewhere and referred to by a command". This is that
//! elsewhere.
//!
//! A plain span of words rather than a queue or a cell, because the traffic is
//! neither. Frames are written once, before the command that names them, and
//! then read for as long as they play — so what orders the write against the
//! read is the ring rather than anything here: the release on its tail and the
//! acquire on the far side put the frames behind the command that refers to
//! them.
//!
//! It sits in the region rather than in a static of its own because it crosses
//! a thread boundary, which is the line `escapement-worklet`'s `lib.rs` draws
//! between the two — the output block never crosses one, and has exports
//! instead of a place in the header.

/// Where the frames sit inside the region, in words from its base.
///
/// A size as well as a base, unlike [`BlockLayout`](crate::BlockLayout): there
/// is one state block holding one `EngineState`, so a size there could take
/// exactly one value, while this is as large as the side that owns the region
/// chose to make it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AudioLayout {
    base: usize,
    words: usize,
}

impl AudioLayout {
    /// `words` is the whole buffer, not what happens to be in it — what is in
    /// it arrives as [`CommandKind::Audio`](crate::CommandKind::Audio) and is
    /// bounded by this.
    #[must_use]
    pub const fn new(base: usize, words: usize) -> Self {
        Self { base, words }
    }

    /// First word of the buffer.
    #[must_use]
    pub const fn base(&self) -> usize {
        self.base
    }

    /// How many words it holds.
    #[must_use]
    pub const fn words(&self) -> usize {
        self.words
    }

    /// First word after it.
    #[must_use]
    pub const fn end(&self) -> usize {
        self.base + self.words
    }
}

#[cfg(test)]
#[cfg(not(loom))]
mod tests {
    use super::*;

    /// A base and a size that are both non-zero and different from each other,
    /// so that an end reached by any other arithmetic on the two lands
    /// somewhere else rather than on the same answer.
    #[test]
    fn a_buffer_ends_a_size_after_its_base() {
        let audio = AudioLayout::new(100, 7);

        assert_eq!(audio.base(), 100);
        assert_eq!(audio.words(), 7);
        assert_eq!(audio.end(), 107);
    }
}
