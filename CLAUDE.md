# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

A Cargo workspace and a pnpm workspace in one repository. `CONTRIBUTING.md` has the ground rules; `docs/architecture.md` the whole picture, most of it still planned; `docs/adr/` one decision per file. An accepted ADR is amended by a new one rather than rewritten, so read its status line before relying on the text. Changing a decision is the user's call, not something to fold into a code change.

## Commands

```bash
# what CI runs
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
pnpm check                       # biome, tsc, vitest

cargo xtask generate             # regenerate the boundary; CI fails on drift
pnpm format                      # biome format --write .

# a single test
cargo test -p xtask check_names_what_is_wrong
cargo test -p protocol --test vectors commands_match_their_vectors
npx vitest run -t "stop matches its vector"
```

The toolchain is pinned in `rust-toolchain.toml`, Node in `.nvmrc`, pnpm in `packageManager`.

## The engine boundary is generated

A Rust engine (WASM, AudioWorklet) and a TypeScript upper half share memory. `schema/boundary.toml` is the single source for that format; `cargo xtask generate` emits `crates/protocol/src/generated.rs` and `packages/protocol/src/generated.ts`.

- **Never hand-edit the generated files, and never hand-write an offset or an enum value.** Change the schema and regenerate.
- **The generator computes no layout.** Offsets are written by hand in the schema; the generator checks alignment, overlap and fit, then emits what is written. Checks in `xtask/src/schema.rs`, emitters beside it.
- **The generator is the deliverable**, so a bug in it is fixed by making it handle the case, not by rejecting the input.
- A **record** is a map of memory, reinterpreted from bytes, so its offsets are repeated as `offset_of!` assertions and its fields tile its size. A **command** is a value, marshalled field by field, so its Rust layout is not asserted and it may leave a gap (ADR-0017).

## The real-time rules are enforced, not advisory

ADR-0002 forbids allocation, locks and panics on the audio path, and CI checks some of it mechanically.

- **No atomics in `crates/`.** On wasm32 without the atomics feature they lower to plain loads and stores — code that looks synchronised and is not. Synchronisation lives on the JavaScript side, and the `boundary` job greps for it.
- **`crates/protocol` is under the workspace real-time lints.** A `[lints]` table covers every target in its package, so a test that needs to panic turns them off in its own file.
- **Generated Rust indexes only by constants**, which is why array access is unrolled: a constant index into a fixed-size array emits no run-time check, a runtime index carries a bounds check and a panic path.
- The TypeScript hot path is free functions taking `(view, base)`; the cold path returns a snapshot. Both are functional (ADR-0018), the difference is what may allocate.
