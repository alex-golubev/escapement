# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A browser DAW. All audio is computed by a single Rust engine compiled to WASM and run inside one `AudioWorkletProcessor`. Web Audio's built-in nodes are not used for anything except the final connection to `destination`.

## Commands

```sh
cargo test                                   # all tests, native target
cargo test transport::                       # one module
cargo test clicks_land_exactly_on_beats      # one test
cargo check
./scripts/build-wasm.sh                      # release WASM → web/public/engine.wasm
```

`scripts/build-wasm.sh` must be used instead of a bare `cargo build`: it forces the build from the workspace root (see profiles below), checks that the `wasm32-unknown-unknown` target is installed, and verifies via `node` that the compiled module still exports every ABI function plus `memory`. **When adding or renaming an exported ABI function, update the `expected` array in that script** — a lost `#[unsafe(no_mangle)]` otherwise produces a successful build and a silently useless module.

The planned `web/` half (Vite host, worklet, SAB ring writer, Svelte UI) does not exist yet — `web/public/engine.wasm` is a build artifact and is gitignored.

## Current state

The first milestone is the skeleton: a metronome computed in Rust, and nothing beyond it. The Rust half is done — transport, command codec, ring decoding, metronome, C-ABI. Still missing: the worklet, the SAB ring buffer, the Vite host with COOP/COEP headers, and the first sound.

**The rule for this milestone is to stop at the metronome.** No sampler, no pattern, no extra ABI functions. The temptation to keep going is strongest here, because the scaffolding is already in front of you — and a skeleton that was never finished is a skeleton verified nowhere.

## Architecture

### Memory: two buffers that are not the same buffer

The `SharedArrayBuffer` and the WASM linear memory are distinct. The ring buffers live in the SAB and the engine never sees them; `engine_cmd_ptr` / `engine_telemetry_ptr` address WASM linear memory and are *exchange points*, not the rings themselves. Per quantum the worklet copies command bytes SAB → linear memory, calls `engine_process`, then copies telemetry back linear memory → SAB under a seqlock.

Two consequences that shape the Rust code:

- Every hot-path buffer is allocated once in `engine_new` and never moves again. `memory.grow` detaches every JS view over linear memory, and the growth could happen inside `port.onmessage` between two `process()` calls. `lib.rs::buffers_never_move` is the test that pins this.
- `CMD_CAPACITY` (256 records) is the size of the exchange area, not of the SAB ring (1024 records). Overflow is not an error: the remainder waits one quantum.

### Ownership split

`Instance` (in `lib.rs`) owns the memory whose addresses are handed out. `Engine` (in `engine.rs`) owns nothing and takes slices:

```rust
pub fn process(&mut self, out_l: &mut [f32], out_r: &mut [f32], commands: &[u8], cmd_count: u32)
pub fn write_telemetry(&self, words: &mut [u32])
```

This is not stylistic. Rendering proceeds in segments *between* commands, so a quantum must read the command block while mutating transport state — if both were fields of `self`, the borrows would conflict. It also makes `Engine` allocation-free and able to render into an arbitrary buffer, which is what the offline renderer will need.

**All `unsafe` lives in `lib.rs`.** Everything else is safe Rust tested with plain `cargo test` on the native target.

### The command protocol is a two-file contract

`crates/engine/src/commands.rs` and `web/src/audio/protocol.ts` describe the same 16-byte little-endian record and are edited together. A mismatch produces silently wrong behavior that is very expensive to diagnose. The guards:

- `PROTOCOL_VERSION` — bump on any layout or opcode change.
- `engine_protocol_version()` is exported so the check compares against a number that came out of the *compiled engine*. The version field in the SAB header is written by the UI, so comparing it against `protocol.ts` compares JS with itself and proves nothing.
- `commands::tests::wire_format_is_pinned` fails on any byte-layout change — that failure is the signal to update both sides.

Transport position is `u64` end to end, carried as two `u32` words (lo/hi) in both the protocol and the telemetry. On the JS side it stays a plain `number` (exact to 2^53); `BigInt` is not used anywhere.

### Everything crossing the ABI is untrusted

Another thread writes the command bytes and supplies the record count, so every index is checked, every pointer is null-checked, `frames` is clamped to `max_frames`, and `cmd_count` is clamped to the actual slice. Unknown opcodes decode to `None` rather than panicking. Release builds set `panic = "abort"`, so a single panic kills the worklet and sound is gone until the page reloads — there is no recoverable failure mode here. Both `ring.rs` and `lib.rs` carry fuzz-style tests that feed xorshift garbage through the decoder.

### Rules for any module that touches samples

Checked at review alongside "no allocations". These defects surface far from where they were introduced:

1. **Flush denormals explicitly.** WASM has no FPU flush-to-zero, and the symptom is CPU climbing *during silence*. Any module with feedback state (filters, delays, envelopes, meter ballistics, parameter smoothing) runs its state through `fz()` — threshold `1e-20`.
2. **Interpolate parameters per frame** — a stepped gain/cutoff/pan change is zipper noise.
3. **No NaN or Inf on the output.** One NaN poisons feedback permanently. Debug builds assert at module boundaries.
4. **Deterministic.** No wall-clock time, no ambient randomness; noise only from an explicitly seeded generator. The golden render tests compare bit for bit.
5. **Explicit `reset()`** returning the module to its as-constructed state, or the offline render compares a warmed-up instance against a cold one.

### Timing

`Transport` keeps `sample_pos: u64` and is the single source of truth. Musical position is *computed* from the sample position, never accumulated frame by frame — accumulation drifts, and the drift only shows up ten minutes into a track. A tempo change drops an anchor (`epoch_sample` + `epoch_beat`) and counts from it, so the musical grid stays continuous and error cannot pile up across changes. `transport::tests::no_drift_over_long_run` exists to catch anyone rewriting `sample_of_beat` as accumulation.

## Cargo layout gotchas

- `[profile.*]` is read **only** from the root `Cargo.toml`. In a workspace member it is silently ignored, and you get a build with no `lto` and no `panic = "abort"` that looks entirely successful.
- `panic = "abort"` is in `[profile.release]` only — in dev/test it breaks the test harness, which needs unwind.
- `crate-type = ["cdylib", "rlib"]`. Without `rlib`, integration tests under `tests/` and benchmarks do not link at all.

## Test style

Tests here are documentation of *why*, not just coverage. Test names are sentences and comments explain the failure being guarded against — match that style when adding to them.