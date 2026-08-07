//! The DAW audio engine.
//!
//! The internal modules are written in safe Rust and tested with plain
//! `cargo test` on the native target. All `unsafe` will come later and will
//! be locked up in the C-ABI layer (§5.2).

pub mod commands;
pub mod engine;
pub mod ring;
pub mod transport;
