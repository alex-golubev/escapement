//! How the two sides reach the bytes.
//!
//! This is the only thing that differs between them, so it is the only thing
//! behind a trait. The worklet owns the memory and uses [`Pointers`]; the
//! interface and the workers reach into it through a typed-array view, which
//! lands here in slice 1 step 3.

/// The crate's only `unsafe`.
#[allow(unsafe_code)]
pub mod pointers;
#[cfg(test)]
pub mod testing;

pub use pointers::Pointers;

use core::sync::atomic::{fence, Ordering};

/// Word-addressed access to the shared region.
///
/// Offsets are word indices from the base of the region, never byte offsets and
/// never absolute addresses — the two sides do not agree on those.
///
/// Orderings are named rather than passed as a parameter. The outside
/// implementation goes through `Atomics`, which are sequentially consistent and
/// cannot honour a weaker request; a parameter it silently ignored would be a
/// lie. Named methods let it satisfy all four honestly, by being stronger.
pub trait Cells {
    fn load_relaxed(&self, word: usize) -> u32;
    fn load_acquire(&self, word: usize) -> u32;
    fn store_relaxed(&self, word: usize, value: u32);
    fn store_release(&self, word: usize, value: u32);

    /// Bulk read, no ordering of its own.
    ///
    /// Callers get their ordering from the atomic that guards the block — the
    /// ring's head, the state block's sequence. Racy on purpose in the second
    /// case, which is why it is spelled out of relaxed atomics rather than a
    /// plain copy: a torn read is expected there and handled, a data race in the
    /// abstract machine is not. On wasm a relaxed load is an ordinary load.
    fn read_words(&self, at: usize, into: &mut [u32]) {
        for (offset, word) in into.iter_mut().enumerate() {
            *word = self.load_relaxed(at + offset);
        }
    }

    /// Everything before this is finished before any store that follows it.
    ///
    /// A fence is thread-wide rather than about one word, so it sits here only
    /// because this is where the memory model lives, next to the loads and
    /// stores it orders.
    fn fence_release(&self) {
        fence(Ordering::Release);
    }

    /// Nothing after this starts before a load that precedes it. See
    /// [`Cells::fence_release`].
    fn fence_acquire(&self) {
        fence(Ordering::Acquire);
    }

    /// Bulk write. See [`Cells::read_words`].
    fn write_words(&self, at: usize, from: &[u32]) {
        for (offset, word) in from.iter().enumerate() {
            self.store_relaxed(at + offset, *word);
        }
    }
}
