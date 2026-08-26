//! How the two sides reach the bytes.
//!
//! This is the only thing that differs between them, so it is the only thing
//! behind a trait. The worklet owns the memory and uses [`Pointers`]; the
//! interface and the workers reach into it through a typed-array view, which is
//! `escapement-view` and not here — it needs `js-sys`, and cargo unifies
//! features across a workspace build, so a feature on this crate would have put
//! `js-sys` in the worklet.

#[cfg(test)]
#[cfg(loom)]
pub(crate) mod loom;
/// The crate's only `unsafe`.
#[allow(unsafe_code)]
pub mod pointers;
#[cfg(test)]
#[cfg(not(loom))]
pub(crate) mod testing;

pub use pointers::Pointers;

// The one place that knows about `loom`. Swapping the fence here rather than in
// a `loom`-only implementation is what makes the model exercise the fence that
// ships: an override would have `loom` checking a different function.
#[cfg(loom)]
use ::loom::sync::atomic::{fence, Ordering};
#[cfg(not(loom))]
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
    /// How many words this reaches. The handshake is what wants it: a header
    /// cannot describe the memory it was found in, so this is what
    /// [`Layout::read_header`](crate::Layout::read_header) checks it against.
    fn words(&self) -> usize;

    /// A load with no ordering of its own — on wasm, an ordinary load.
    ///
    /// What orders it is the atomic guarding the block it belongs to, never
    /// this call.
    fn load_relaxed(&self, word: usize) -> u32;

    /// Reads a word, and with it everything the other side wrote before
    /// publishing it with [`Cells::store_release`].
    fn load_acquire(&self, word: usize) -> u32;

    /// A store with no ordering of its own. See [`Cells::load_relaxed`].
    fn store_relaxed(&self, word: usize, value: u32);

    /// Publishes this word, and everything written before it, to whoever reads
    /// it with [`Cells::load_acquire`].
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
    /// A fence is thread-wide rather than about one word, and sits here because
    /// this is where the memory model lives. Not overridable, and `loom` is the
    /// only thing that checks it — CLAUDE.md says why to both.
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

// A backend is a value, and both halves of a ring hold one, so they hold it
// through a handle. Written once here rather than once per backend — and only
// for the handles the crate uses: a blanket over `Deref` would claim every
// future type that happens to deref to a `Cells`.
impl<C: Cells + ?Sized> Cells for &C {
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

#[cfg(test)]
#[cfg(not(loom))]
mod tests {
    use super::*;
    use crate::access::testing::Words;

    /// Everything downstream is generic over `Cells`, so this is too — and it is
    /// handed a value and then a handle to the same words. Erasing that
    /// difference is the blanket impl's whole job, and `words` in particular is
    /// what the handshake trusts to be the truth about the memory.
    fn behaves_like_the_region<C: Cells>(cells: &C, size: usize) {
        assert_eq!(cells.words(), size);

        cells.store_relaxed(0, 7);
        cells.store_release(1, 9);
        assert_eq!(cells.load_relaxed(0), 7);
        assert_eq!(cells.load_acquire(1), 9);

        cells.write_words(2, &[10, 20]);
        let mut read = [0u32; 2];
        cells.read_words(2, &mut read);
        assert_eq!(read, [10, 20]);
    }

    #[test]
    fn a_handle_reaches_what_the_value_reaches() {
        let words = Words::new(4);

        behaves_like_the_region(&words, 4);
        // The double reference is the point: `C` is `&Words` here, so this is
        // the blanket impl and the line above is not.
        behaves_like_the_region(&&words, 4);
    }
}
