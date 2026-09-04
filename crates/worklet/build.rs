//! Memory layout for the worklet module. Per crate rather than in
//! `.cargo/config.toml`, and fixed rather than growable —
//! `.claude/rules/wasm-build.md` carries both arguments.
//!
//! `initial == maximum` is what makes it fixed: growth past the maximum fails.

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
