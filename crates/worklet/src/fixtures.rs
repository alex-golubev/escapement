//! What more than one test module in this crate needs.
//!
//! The region and its shape, which every test here builds one of — and which
//! the crate's two test modules were each building for themselves.

use core::sync::atomic::AtomicU32;

use escapement_protocol::{Layout, Pointers};

use crate::processor::COMMAND_SLOTS;

/// The layout a test builds its region from.
///
/// Sixty-four words of audio buffer, where what ships is four megabytes of them
/// (`processor::AUDIO_WORDS`). Every test here allocates a region and fills it
/// with atomics one at a time, and Miri then walks every one of those — which
/// took the crate's Miri run from eight seconds to longer than it was worth
/// waiting for. Enough words for a few frames says everything about this code
/// that four million would; the size that ships is a fact about the module's
/// memory, and `build.rs` with `tools/check-shared-memory.py` is what holds it.
pub(crate) const LAYOUT: Layout = Layout::new(COMMAND_SLOTS, 64);

/// The words a region sits in.
///
/// Held by the test and lent out rather than owned by whatever reaches it: a
/// `Box` moved after its pointer was taken is no longer at the address that
/// pointer holds, which Miri named as undefined behaviour the first time this
/// crate was put under it. Leaking it instead trades that for a leak Miri also
/// reports, so the borrow is the answer — and it is what the worklet has too,
/// where the region is a `static` that outlives everything reaching it.
pub(crate) fn words() -> Box<[AtomicU32]> {
    (0..LAYOUT.words()).map(|_| AtomicU32::new(0)).collect()
}

/// `Pointers` is what ships, so a test reaches the region the way the worklet
/// does rather than through a stand-in for it.
pub(crate) fn cells(words: &[AtomicU32]) -> Pointers {
    // SAFETY: `words` is exactly `len` initialized, aligned cells, and the
    // caller holds them still for as long as the value is used.
    unsafe { Pointers::new(words.as_ptr(), words.len()) }
}
