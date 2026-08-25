//! The wasm module running inside `AudioWorkletGlobalScope`. Its linear memory
//! is where the rings live, and it exports it (ARCHITECTURE.md §3).
//!
//! No `wasm-bindgen` on purpose: a bare `cdylib` links with zero imports and
//! instantiates straight from bytes, which the worklet has to do anyway — there
//! is no `fetch` in here (§1).
//!
//! Five entry points, and `worklet.js` is a shim over them that moves bytes and
//! never touches a sample. The output buffer keeps two of its own rather than
//! being described by the header, because the side that needs it is
//! `worklet.js` itself, every quantum, on this thread — putting it in the
//! header would mean parsing the header in JavaScript, which is the one thing
//! the protocol exists to avoid (§4). It never crosses a thread boundary; the
//! region does.

use core::cell::UnsafeCell;
use core::sync::atomic::AtomicU32;

use escapement_core::RENDER_QUANTUM;
use escapement_protocol::Pointers;

mod processor;

use processor::{Processor, LAYOUT};

/// The shared region: header, command ring, state block.
///
/// Real atomics and no wrapper, unlike the two below — this is the one thing
/// here that two threads genuinely touch, and it is the whole reason the
/// module's memory is shared. All zeros, so it costs `.bss` and not a data
/// segment: measured at 58 bytes of module for 8 KiB of region.
///
/// It never moves. The memory is fixed at link time (`build.rs`), so there is
/// no `memory.grow` to relocate anything, which is what [`Pointers`] is
/// promised.
static REGION: [AtomicU32; LAYOUT.words()] = [const { AtomicU32::new(0) }; LAYOUT.words()];

/// For what the audio thread alone touches.
///
/// The rings have arrived now, and this is the answer to the note that used to
/// stand here: the shared region is above, in real atomics, and what is left
/// under this wrapper is what the `extern "C"` entry points reach sequentially
/// on one thread. `worklet.js` reads [`OUTPUT`] inside the same `process()`
/// call that filled it.
struct SingleThreaded<T>(UnsafeCell<T>);

// SAFETY: see above — the `extern "C"` entry points are called sequentially,
// from the audio thread, and nothing else in the module has an address for
// either of these.
unsafe impl<T> Sync for SingleThreaded<T> {}

static ENGINE: SingleThreaded<Option<Processor>> = SingleThreaded(UnsafeCell::new(None));
static OUTPUT: SingleThreaded<[f32; RENDER_QUANTUM]> =
    SingleThreaded(UnsafeCell::new([0.0; RENDER_QUANTUM]));

/// Call once, before the first [`escapement_process`], and before the address
/// from [`escapement_region_ptr`] is handed to anyone: this is what writes the
/// header the other side reads.
///
/// The sample rate is an argument because `sampleRate` exists only inside
/// `AudioWorkletGlobalScope` — it cannot be asked for from in here.
#[no_mangle]
pub extern "C" fn escapement_init(sample_rate_hz: f32) {
    // SAFETY: `REGION` is a `static` of exactly `len` initialized `AtomicU32`
    // in a memory that cannot grow, so the pointer is valid for the life of the
    // module.
    let cells = unsafe { Pointers::new(REGION.as_ptr(), REGION.len()) };

    // SAFETY: see `SingleThreaded`.
    unsafe { *ENGINE.0.get() = Some(Processor::new(cells, sample_rate_hz)) };
}

/// Where the shared region starts, as an offset into `memory.buffer`.
///
/// Everything else about the region — how big it is, where the ring and the
/// state block sit inside it — is in the header at this address, so this is the
/// only number the other side is told rather than shown (§3). Stable for the
/// life of the module.
#[no_mangle]
pub extern "C" fn escapement_region_ptr() -> *const u32 {
    REGION.as_ptr().cast()
}

/// Stable for the life of the module.
#[no_mangle]
pub extern "C" fn escapement_output_ptr() -> *mut f32 {
    OUTPUT.0.get().cast()
}

/// In samples, so the host never hard-codes 128 on its side.
#[no_mangle]
pub extern "C" fn escapement_output_len() -> usize {
    RENDER_QUANTUM
}

/// Silence until [`escapement_init`] has run — a missed init must not be a panic
/// on the audio thread.
#[no_mangle]
pub extern "C" fn escapement_process() {
    // SAFETY: see `SingleThreaded`.
    unsafe {
        let out = &mut *OUTPUT.0.get();
        match (*ENGINE.0.get()).as_mut() {
            Some(engine) => engine.process(out),
            None => out.fill(0.0),
        }
    }
}
