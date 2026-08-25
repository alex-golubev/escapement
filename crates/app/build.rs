//! Memory layout for the UI module. See `crates/worklet/build.rs` for why this
//! lives per crate.
//!
//! The opposite of the worklet: this one grows. It holds the CRDT document,
//! waveform peaks and undo history, none of which have a size known up front, and
//! nothing here runs on the audio thread — `memory.grow` is allowed to cost.

/// A ceiling, not a reservation: the module starts at whatever its data needs
/// and grows into this.
const MAX_MEMORY_BYTES: usize = 1024 * 1024 * 1024;

fn main() {
    println!("cargo::rerun-if-changed=build.rs");

    if std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() != Ok("wasm32") {
        return;
    }

    println!("cargo::rustc-link-arg-bins=--shared-memory");
    println!("cargo::rustc-link-arg-bins=--max-memory={MAX_MEMORY_BYTES}");
}
