//! Memory layout for the UI module. See `crates/worklet/build.rs` for why this
//! lives per crate.
//!
//! `rustc-link-arg` rather than `-bins`: a test target is neither, and the
//! check that the memory came out shared has to run against a module linked
//! the way this one is — otherwise it answers about a different build.
//!
//! The opposite of the worklet: this one grows. It holds the CRDT document,
//! waveform peaks and undo history, none of which have a size known up front, and
//! nothing here runs on the audio thread — `memory.grow` is allowed to cost.

/// A ceiling, and — as CLAUDE.md says of the worklet's — address space a shared
/// memory reserves up front either way. What grows is how much of it is real,
/// and that starts at whatever the module's data needs.
const MAX_MEMORY_BYTES: usize = 1024 * 1024 * 1024;

/// The linker synthesizes these for a shared memory and then drops them again,
/// because nothing in the module refers to them. `wasm-bindgen` looks them up
/// by name when it prepares a module for threading, so they have to survive the
/// link — exporting them is what keeps them.
const TLS_SYMBOLS: [&str; 4] = ["__wasm_init_tls", "__tls_size", "__tls_align", "__tls_base"];

fn main() {
    println!("cargo::rerun-if-changed=build.rs");

    if std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() != Ok("wasm32") {
        return;
    }

    println!("cargo::rustc-link-arg=--shared-memory");
    println!("cargo::rustc-link-arg=--max-memory={MAX_MEMORY_BYTES}");

    // `wasm-bindgen` refuses a shared memory the module defines for itself: its
    // threading transform hands the same memory to workers, so it has to be
    // created outside and imported. The generated glue is what creates it.
    println!("cargo::rustc-link-arg=--import-memory");

    for symbol in TLS_SYMBOLS {
        println!("cargo::rustc-link-arg=--export={symbol}");
    }
}
