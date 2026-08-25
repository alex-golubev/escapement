//! Memory layout for the worklet module.
//!
//! Per crate rather than in `.cargo/config.toml`: `rustflags` there apply to
//! every crate built for the target, and this memory is not like the others. It
//! is the transport the rings live in (ARCHITECTURE.md §3), and §1 wants it
//! fixed — no `memory.grow` on the audio thread.
//!
//! `initial == maximum` is what makes it fixed: growth past the maximum fails.
//! `memory.grow` is not a bounded operation and a quantum at 48 kHz is 2.7 ms,
//! so it must never be reachable from `process`. Shared memory reserves its
//! maximum at instantiation anyway — growing buys no address space, only the
//! chance of asking the engine for pages mid-callback.

/// 32 MiB. Slice 1 needs about one, but the graph, voice pools and stretch
/// buffers are all preallocated here later, and raising this later means
/// invalidating every view the UI holds. Room now is cheaper than a move.
const MEMORY_BYTES: usize = 32 * 1024 * 1024;

fn main() {
    println!("cargo::rerun-if-changed=build.rs");

    // Host builds (`cargo test`) link with the native linker, which does not
    // know these flags.
    if std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() != Ok("wasm32") {
        return;
    }

    println!("cargo::rustc-link-arg-cdylib=--shared-memory");
    println!("cargo::rustc-link-arg-cdylib=--initial-memory={MEMORY_BYTES}");
    println!("cargo::rustc-link-arg-cdylib=--max-memory={MEMORY_BYTES}");
}
