//! Access for the side that owns the memory. All the `unsafe` in this crate is
//! in this file.

use core::sync::atomic::{AtomicU32, Ordering};

use super::Cells;

/// The region seen as a run of words at a known address.
#[derive(Clone, Copy, Debug)]
pub struct Pointers {
    base: *const AtomicU32,
    words: usize,
}

impl Pointers {
    /// # Safety
    ///
    /// `base` must point at `words` initialized, four-byte-aligned `AtomicU32`
    /// that stay put for as long as this value is used. In the worklet that is a
    /// `static` in a memory that cannot grow, so the pointer never moves.
    pub const unsafe fn new(base: *const AtomicU32, words: usize) -> Self {
        Self { base, words }
    }

    fn cell(&self, word: usize) -> &AtomicU32 {
        // Offsets reach here from a `Layout` compiled into this module and from
        // ring indices already masked to capacity, so this cannot fire. It is
        // here to catch a layout mistake in a debug build rather than a wrong
        // read in a release one.
        debug_assert!(word < self.words, "word {word} outside the region");

        // SAFETY: `new` promised `words` cells at `base`, and `word` is below
        // `words`.
        unsafe { &*self.base.add(word) }
    }
}

impl Cells for Pointers {
    fn load_relaxed(&self, word: usize) -> u32 {
        self.cell(word).load(Ordering::Relaxed)
    }

    fn load_acquire(&self, word: usize) -> u32 {
        self.cell(word).load(Ordering::Acquire)
    }

    fn store_relaxed(&self, word: usize, value: u32) {
        self.cell(word).store(value, Ordering::Relaxed);
    }

    fn store_release(&self, word: usize, value: u32) {
        self.cell(word).store(value, Ordering::Release);
    }
}

#[cfg(test)]
#[cfg(not(loom))]
mod tests {
    use std::boxed::Box;

    use super::*;

    #[test]
    fn each_word_is_its_own_cell() {
        let region: Box<[AtomicU32]> = (0..4).map(|_| AtomicU32::new(0)).collect();
        // SAFETY: `region` outlives `cells` and holds exactly `len` cells.
        let cells = unsafe { Pointers::new(region.as_ptr(), region.len()) };

        cells.store_relaxed(1, 7);
        cells.store_release(2, 9);

        assert_eq!(cells.load_relaxed(1), 7);
        assert_eq!(cells.load_acquire(2), 9);
        assert_eq!(cells.load_relaxed(0), 0, "a neighbour was written");
        assert_eq!(cells.load_relaxed(3), 0, "a neighbour was written");
    }

    #[test]
    fn a_block_lands_where_it_was_put() {
        let region: Box<[AtomicU32]> = (0..8).map(|_| AtomicU32::new(0)).collect();
        // SAFETY: as above.
        let cells = unsafe { Pointers::new(region.as_ptr(), region.len()) };

        cells.write_words(2, &[10, 20, 30]);
        let mut read = [0u32; 3];
        cells.read_words(2, &mut read);

        assert_eq!(read, [10, 20, 30]);
        assert_eq!(cells.load_relaxed(1), 0, "a neighbour was written");
        assert_eq!(cells.load_relaxed(5), 0, "a neighbour was written");
    }
}
