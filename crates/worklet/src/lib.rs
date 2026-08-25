//! The wasm module running inside `AudioWorkletGlobalScope`. Its linear memory
//! is where the rings live, and it exports it (ARCHITECTURE.md §3).
//!
//! No `wasm-bindgen` on purpose: a bare `cdylib` links with zero imports and
//! instantiates straight from bytes, which the worklet has to do anyway — there
//! is no `fetch` in here (§1).
//!
//! `worklet.js` is a shim over the entry points below: it moves bytes and never
//! touches a sample. The output buffer keeps two of its own rather than being
//! described by the header, because the side that needs it is `worklet.js`
//! itself, every quantum, on this thread — putting it in the header would mean
//! parsing the header in JavaScript, which is the one thing the protocol exists
//! to avoid (§4). It never crosses a thread boundary; the region does.

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

/// For what the audio thread alone touches: what the `extern "C"` entry points
/// reach sequentially on one thread, never two. `worklet.js` reads [`OUTPUT`]
/// inside the same `process()` call that filled it.
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

/// Where the shared region starts, as an offset into `memory.buffer`. Stable
/// for the life of the module.
///
/// The only number the other side is told rather than shown: everything else
/// about the region is in the header at this address (§3).
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

#[cfg(test)]
mod tests {
    use escapement_protocol::{Command, CommandKind, Layout, Producer, Subscriber};

    use super::*;

    /// Reads the output buffer out into a value of its own.
    ///
    /// A borrow of it cannot be held across [`escapement_process`], which takes
    /// `&mut` to the same words — that is the aliasing the module is careful
    /// about, and a test is not exempt from it.
    fn output() -> std::vec::Vec<f32> {
        let ptr = escapement_output_ptr();
        let len = escapement_output_len();

        // SAFETY: those two describe `OUTPUT`, a `static` of exactly `len`
        // initialized `f32`. Nothing else is borrowing it here: the module is
        // between calls to `escapement_process`.
        unsafe { core::slice::from_raw_parts(ptr, len) }.to_vec()
    }

    /// The module as `worklet.js` uses it, over the module's own statics: init,
    /// take the region's address, read the header, send a command into it,
    /// render, read the state back.
    ///
    /// One test rather than several, and that is the whole safety argument —
    /// these statics are the module's only copy, and `cargo test` runs tests on
    /// several threads. A second test touching them would race with this one.
    /// Everything that does not need them lives in `processor.rs`, which is
    /// handed its memory instead.
    #[test]
    fn the_module_answers_through_its_entry_points() {
        escapement_init(48_000.0);

        // SAFETY: the exported pointer is the base of `REGION`, a `static` of
        // exactly this many cells that never moves.
        let cells = unsafe { Pointers::new(escapement_region_ptr().cast(), LAYOUT.words()) };
        let seen = Layout::read_header(&cells).expect("init did not write a header");

        escapement_process();
        assert!(
            output().iter().all(|sample| *sample == 0.0),
            "a transport nobody started made a sound"
        );

        let mut interface = Producer::new(cells, seen.commands());
        interface.push(&Command::now(CommandKind::Start)).unwrap();

        escapement_process();
        assert!(
            output().iter().any(|sample| *sample != 0.0),
            "Start did not reach the engine"
        );

        let state = Subscriber::new(cells, seen.state())
            .read()
            .expect("the writer was not in the way");
        assert!(state.playing);
        assert_eq!(state.quanta, 2);
        assert_eq!(state.commands_applied, 1);
    }
}
