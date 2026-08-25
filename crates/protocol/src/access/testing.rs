//! Access to a plain allocation, so the protocol can be driven by two real
//! threads under `cargo test` instead of only in a browser.

use core::sync::atomic::{AtomicU32, Ordering};
use std::boxed::Box;

use super::Cells;

pub struct Words(Box<[AtomicU32]>);

impl Words {
    pub fn new(words: usize) -> Self {
        Self((0..words).map(|_| AtomicU32::new(0)).collect())
    }
}

impl Cells for Words {
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
