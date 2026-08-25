//! Access backed by `loom`'s atomics, so that the interleavings can be
//! enumerated instead of sampled.
//!
//! `loom` replaces the atomic types with instrumented ones and runs the model
//! once per execution the memory model permits, including the reorderings a weak
//! machine is allowed to produce. That is what the two-thread stress tests
//! cannot do: they observe one interleaving on one machine, and on x86 they
//! would pass with `Relaxed` everywhere.

use std::sync::Arc;
use std::vec::Vec;

use ::loom::sync::atomic::{AtomicU32, Ordering};

use super::Cells;

pub struct LoomWords(Vec<AtomicU32>);

impl LoomWords {
    /// Call inside `loom::model`: the atomics belong to one execution.
    pub fn new(words: usize) -> Self {
        Self((0..words).map(|_| AtomicU32::new(0)).collect())
    }
}

impl Cells for LoomWords {
    fn words(&self) -> usize {
        self.0.len()
    }

    fn load_relaxed(&self, word: usize) -> u32 {
        self.0[word].load(Ordering::Relaxed)
    }

    fn load_acquire(&self, word: usize) -> u32 {
        self.0[word].load(Ordering::Acquire)
    }

    fn store_relaxed(&self, word: usize, value: u32) {
        self.0[word].store(value, Ordering::Relaxed);
    }

    fn store_release(&self, word: usize, value: u32) {
        self.0[word].store(value, Ordering::Release);
    }
}

// `loom::thread::spawn` wants `'static`, so the halves hold an `Arc` rather than
// a borrow the way the other backends do. Generic for the same reason the
// borrowing impl next to it is: so the next handle does not add a fourth copy.
impl<C: Cells + ?Sized> Cells for Arc<C> {
    fn words(&self) -> usize {
        (**self).words()
    }

    fn load_relaxed(&self, word: usize) -> u32 {
        (**self).load_relaxed(word)
    }

    fn load_acquire(&self, word: usize) -> u32 {
        (**self).load_acquire(word)
    }

    fn store_relaxed(&self, word: usize, value: u32) {
        (**self).store_relaxed(word, value);
    }

    fn store_release(&self, word: usize, value: u32) {
        (**self).store_release(word, value);
    }
}
