//! Leptos client — and not yet. What is here is slice 1's second probe: whether
//! a module linked with a growable shared memory comes up at all through
//! `wasm-bindgen` and Trunk, which is the ground `escapement-view` has to stand
//! on before it is worth wiring to anything.
//!
//! `console` rather than the DOM: reaching the document needs `web-sys`, and a
//! probe that answers one question should not be the thing that decides that.

use wasm_bindgen::prelude::*;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console)]
    fn log(text: &str);
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
