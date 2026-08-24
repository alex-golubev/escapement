//! The wasm module running inside `AudioWorkletGlobalScope`.
//!
//! Two things bite here: there is no `fetch`, so the module arrives via
//! `processorOptions` or `port.postMessage`; and `wasm-bindgen` glue assumes a
//! normal module environment, so instantiation likely has to be hand-rolled.
//!
//! Separate wasm instance with its own linear memory — all exchange with the UI
//! thread goes through `SharedArrayBuffer`.
