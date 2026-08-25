//! Audio core: graph, nodes, mixer, DSP.
//!
//! Runs on the real-time thread: no allocation, locks, panics, I/O or logging on
//! the processing path. Allocation is allowed only while building the graph.
//!
//! `no_std` is what turns the first of those from discipline into a compiler
//! error: with no allocator in this crate's graph there is nothing here to
//! allocate with. It costs one dependency — `f32::sin` lives in `std` — and on
//! wasm that costs nothing at all, see `Cargo.toml`.

#![no_std]

// The tests want a heap and a harness. Asked for here rather than by weakening
// the attribute above, as `escapement-protocol` does.
#[cfg(test)]
extern crate std;

#[cfg(test)]
mod fixtures;

mod engine;
mod sine;

pub use engine::Engine;
pub use sine::Sine;

/// Render quantum fixed by the Web Audio spec. Internal block sizes are multiples
/// of it.
pub const RENDER_QUANTUM: usize = 128;

// The spec's number, not a tuning knob, so changing it has to be deliberate
// enough to edit twice. Stated the way the protocol states its wire sizes: at
// compile time, where nothing can filter it out of a run.
const _: () = assert!(RENDER_QUANTUM == 128);
