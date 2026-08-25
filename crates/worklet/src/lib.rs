//! The wasm module running inside `AudioWorkletGlobalScope`. Its linear memory
//! is where the rings live, and it exports it (ARCHITECTURE.md §3).
//!
//! No `wasm-bindgen` on purpose: a bare `cdylib` links with zero imports and
//! instantiates straight from bytes, which the worklet has to do anyway — there
//! is no `fetch` in here (§1).
//!
//! `worklet.js` is a shim over the entry points below: it moves bytes and never
//! touches a sample. The output block gets two exports of its own rather than a
//! place in the header, because the side that needs it is `worklet.js` itself,
//! every quantum, on this thread — and the header is the one thing JavaScript
//! must never parse (§4). It never crosses a thread boundary; the region does.
//!
//! Three statics and five entry points that only delegate, which is a rule and
//! not a coincidence — CLAUDE.md says why. Behaviour lives in `module.rs` and
//! `processor.rs`, which are handed their memory instead of reaching for this.

use core::cell::UnsafeCell;
use core::sync::atomic::AtomicU32;

use escapement_core::RENDER_QUANTUM;
use escapement_protocol::Pointers;

mod module;
mod processor;

use module::Module;
use processor::LAYOUT;

/// The shared region: header, command ring, state block.
///
/// Real atomics and no wrapper, unlike the two below: this is the one thing
/// here that two threads genuinely touch. All zeros, so it costs `.bss` and not
/// a data segment.
///
/// It never moves — the memory is fixed at link time (`build.rs`), which is
/// what [`Pointers`] is promised.
static REGION: [AtomicU32; LAYOUT.words()] = [const { AtomicU32::new(0) }; LAYOUT.words()];

/// For what the audio thread alone touches.
///
/// A `static` because the C ABI has nowhere to hang state between calls, and
/// behind an `UnsafeCell` rather than atomics because the entry points reach it
/// sequentially, on one thread, and nothing else in the module has an address
/// for it. `worklet.js` reads [`OUTPUT`] inside the same `process()` call that
/// filled it.
struct SingleThreaded<T>(UnsafeCell<T>);

// SAFETY: see above. Two named impls rather than one blanket over every `T`,
// which would promise this for types the argument has never seen.
unsafe impl Sync for SingleThreaded<Module> {}
unsafe impl Sync for SingleThreaded<[f32; RENDER_QUANTUM]> {}

static MODULE: SingleThreaded<Module> = SingleThreaded(UnsafeCell::new(Module::new()));

/// The block the host reads. Its own `static` rather than a field of [`Module`]:
/// `Option<Processor>` is `None` by one non-zero byte, and one non-zero byte
/// takes a whole `static` out of `.bss` into a data segment — these 512 zeros
/// with it.
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
    unsafe { (*MODULE.0.get()).init(cells, sample_rate_hz) };
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

/// One quantum into the block at [`escapement_output_ptr`], silent until
/// [`escapement_init`] has run.
#[no_mangle]
pub extern "C" fn escapement_process() {
    // SAFETY: see `SingleThreaded`. Two distinct statics, so the two `&mut`
    // do not alias.
    unsafe { (*MODULE.0.get()).process(&mut *OUTPUT.0.get()) };
}

#[cfg(test)]
mod tests {
    use escapement_protocol::{Command, CommandKind, Layout, Producer, Subscriber};

    use super::*;

    /// Reads the output block out into a value of its own.
    ///
    /// A borrow of it cannot be held across [`escapement_process`], which takes
    /// `&mut` to the same words — that is the aliasing the module is careful
    /// about, and a test is not exempt from it.
    fn output() -> Vec<f32> {
        let ptr = escapement_output_ptr();
        let len = escapement_output_len();

        // SAFETY: those two describe the module's output block, exactly `len`
        // initialized `f32`. Nothing else is borrowing it here: the module is
        // between calls to `escapement_process`.
        unsafe { core::slice::from_raw_parts(ptr, len) }.to_vec()
    }

    /// The wiring, and only the wiring: that the entry points reach the same
    /// statics, that the address handed out is the region the header went into,
    /// that rendering lands in the block whose address the host holds, and that
    /// what one call leaves the next call finds.
    ///
    /// One test, and nothing enforces that — CLAUDE.md. What keeps it true is
    /// that there is nothing here to put in a second one.
    #[test]
    fn the_module_answers_through_its_entry_points() {
        escapement_init(48_000.0);
        assert_eq!(escapement_output_len(), RENDER_QUANTUM);

        // SAFETY: the exported pointer is the base of `REGION`, a `static` of
        // exactly this many cells that never moves.
        let cells = unsafe { Pointers::new(escapement_region_ptr().cast(), LAYOUT.words()) };
        let seen = Layout::read_header(&cells).expect("init did not write a header");

        let mut interface = Producer::new(cells, seen.commands());
        interface.push(&Command::now(CommandKind::Start)).unwrap();

        escapement_process();
        assert!(
            output().iter().any(|sample| *sample != 0.0),
            "Start did not reach the block the host reads"
        );

        escapement_process();
        let state = Subscriber::new(cells, seen.state())
            .read()
            .expect("the writer was not in the way");
        assert!(state.playing);
        assert_eq!(state.quanta, 2, "the module did not survive between calls");
        assert_eq!(state.commands_applied, 1);
    }
}
