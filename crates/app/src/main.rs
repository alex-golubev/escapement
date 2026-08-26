//! Leptos client — and not yet. What is here is slice 1's page: the interface
//! side of the shared region, exported so that buttons in `web/index.html` can
//! reach it.
//!
//! The buttons stay in the markup rather than being drawn from here. §4 forbids
//! writing the protocol twice, not writing a `<button>`, and drawing one from
//! Rust needs `web-sys` — a decision this page has no business making. Leptos
//! arrives when there is a panel worth testing it on (§4).
//!
//! Everything below is delegation, and deliberately: a `static` exists once per
//! process, so behaviour left here is behaviour a test reaches once and never
//! again. `escapement-view` holds it instead — the same argument the worklet's
//! `lib.rs` carries.

use std::cell::RefCell;

use escapement_view::{Command, CommandKind, Link};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console)]
    fn log(text: &str);
}

thread_local! {
    /// The interface's end of the region, and the queue in front of it.
    ///
    /// A `thread_local!` rather than a `static`: the exports below are reached
    /// from one thread, and this is the shape that says so without `unsafe`.
    static LINK: RefCell<Link> = RefCell::new(Link::new());
}

/// The handshake. `buffer` is the worklet's `memory.buffer` and `region` the
/// offset `escapement_region_ptr` returned — the message `worklet.js` posts
/// once, at startup (§3).
///
/// Whatever the page has queued before this survives it, and so does a refusal.
///
/// # Errors
///
/// If there is no region this build can speak to at that address. The text is
/// meant for a person looking at a page that will not start.
#[wasm_bindgen]
pub fn connect(buffer: &JsValue, region: usize) -> Result<(), JsError> {
    LINK.with_borrow_mut(|link| link.connect(buffer, region))?;
    Ok(())
}

/// Run the transport.
#[wasm_bindgen]
pub fn start() {
    send(CommandKind::Start);
}

/// Stop it, leaving the engine's clock running (§3).
#[wasm_bindgen]
pub fn stop() {
    send(CommandKind::Stop);
}

/// Slice 1 only: the engine is one oscillator.
#[wasm_bindgen]
pub fn set_frequency(hz: f32) {
    send(CommandKind::SetFrequency(hz));
}

/// Master gain, linear. Slice 1 only, as above.
#[wasm_bindgen]
pub fn set_gain(gain: f32) {
    send(CommandKind::SetGain(gain));
}

/// Once a frame: sends what has been waiting, and reads back what the engine
/// says about itself.
///
/// `None` before the handshake, and on a frame where the writer was in the way
/// every time — keep the previous frame's values rather than showing a gap.
#[wasm_bindgen]
#[must_use]
pub fn poll() -> Option<Telemetry> {
    LINK.with_borrow_mut(|link| {
        link.flush();

        let state = link.state()?;
        Some(Telemetry {
            // `f64` rather than `u64`, which would cross as a `BigInt` and be
            // awkward for no gain: 2^53 samples at 48 kHz is six thousand years.
            clock: state.clock as f64,
            quanta: state.quanta as f64,
            peak: state.peak,
            playing: state.playing,
            applied: state.commands_applied,
            unknown: state.commands_unknown,
            pending: link.pending() as u32,
        })
    })
}

/// What the page shows: everything the engine publishes, plus the one number it
/// cannot know — how much the interface has not managed to send yet.
#[wasm_bindgen]
pub struct Telemetry {
    /// Samples the engine has produced since it started.
    pub clock: f64,
    /// Callbacks the host has made. Against `AudioContext.currentTime` this is
    /// where a dropout shows up (§3).
    pub quanta: f64,
    /// Peak of the last quantum, full scale.
    pub peak: f32,
    /// The transport as the engine sees it, which is what a button should
    /// follow rather than what it was last told.
    pub playing: bool,
    /// Commands taken off the ring.
    pub applied: u32,
    /// Commands the engine did not recognize — the two halves have parted
    /// company, and this side is the one that can do something about it.
    pub unknown: u32,
    /// Commands still waiting on this side, for room or for a region.
    pub pending: u32,
}

fn send(kind: CommandKind) {
    LINK.with_borrow_mut(|link| link.send(Command::now(kind)));
}

/// This module's own `WebAssembly.Memory`.
///
/// The page asks it whether the buffer behind it is a `SharedArrayBuffer` —
/// which is the question. `--shared-memory` is checked at build time
/// (`tools/check-shared-memory.py`), but whether the module then instantiates
/// is not something a build can answer.
#[wasm_bindgen]
#[must_use]
pub fn linear_memory() -> JsValue {
    wasm_bindgen::memory()
}

/// Runs on load, before anything on the page can call in.
fn main() {
    log("[escapement] the interface module is up");
}

// Two attributes rather than one `all(...)`, as everywhere else here.
#[cfg(test)]
#[cfg(target_arch = "wasm32")]
mod browser {
    use js_sys::{Reflect, SharedArrayBuffer};
    use wasm_bindgen::JsCast;
    use wasm_bindgen_test::{wasm_bindgen_test, wasm_bindgen_test_configure};

    use super::*;

    wasm_bindgen_test_configure!(run_in_browser);

    /// Whether the memory came out shared, which is the one thing here that no
    /// build answers on its own.
    ///
    /// Measured, because the obvious version of this claim is wrong: dropping a
    /// single flag from `build.rs` is caught by the linker, since the exported
    /// TLS symbols stop existing, and dropping `--import-memory` is caught by
    /// `wasm-bindgen`. What stays silent is the whole block leaving together —
    /// which is exactly the shape it had while this was still a probe. It
    /// links, it runs, and the memory is private.
    #[wasm_bindgen_test]
    fn the_module_runs_on_a_shared_memory() {
        let buffer = Reflect::get(&linear_memory(), &JsValue::from_str("buffer"))
            .expect("a WebAssembly.Memory has a buffer");

        assert!(
            buffer.is_instance_of::<SharedArrayBuffer>(),
            "the module's memory came out private"
        );
    }
}
