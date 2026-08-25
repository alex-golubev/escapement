//! The wasm module running inside `AudioWorkletGlobalScope`. Its linear memory
//! is where the rings live, and it exports it (ARCHITECTURE.md §3).
//!
//! No `wasm-bindgen` on purpose: a bare `cdylib` links with zero imports and
//! instantiates straight from bytes, which the worklet has to do anyway — there
//! is no `fetch` in here (§1).

use core::cell::UnsafeCell;
use escapement_core::{Sine, RENDER_QUANTUM};

/// Reconsider when the rings arrive and a second thread starts reading this
/// memory: today the host calls us one quantum at a time, on one thread.
struct SingleThreaded<T>(UnsafeCell<T>);

// SAFETY: see above — the `extern "C"` entry points are called sequentially.
unsafe impl<T> Sync for SingleThreaded<T> {}

static ENGINE: SingleThreaded<Option<Sine>> = SingleThreaded(UnsafeCell::new(None));
static OUTPUT: SingleThreaded<[f32; RENDER_QUANTUM]> =
    SingleThreaded(UnsafeCell::new([0.0; RENDER_QUANTUM]));

/// Roughly -14 dB, for headphones. The mixer replaces it.
const SAFETY_GAIN: f32 = 0.2;

/// Call once, before the first [`escapement_process`].
#[no_mangle]
pub extern "C" fn escapement_init(sample_rate_hz: f32) {
    // SAFETY: see `SingleThreaded`.
    unsafe { *ENGINE.0.get() = Some(Sine::new(440.0, sample_rate_hz)) };
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
            Some(sine) => {
                sine.process(out);
                for sample in out.iter_mut() {
                    *sample *= SAFETY_GAIN;
                }
            }
            None => out.fill(0.0),
        }
    }
}
