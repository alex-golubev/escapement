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
