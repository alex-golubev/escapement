# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A browser DAW. All audio is computed by a single Rust engine compiled to WASM and run inside one `AudioWorkletProcessor`. Web Audio's built-in nodes are not used for anything except the final connection to `destination`.

## Commands

Rust, from the repository root:

```sh
cargo test                                   # all tests, native target
cargo test transport::                       # one module
cargo test clicks_land_exactly_on_beats      # one test
cargo check
./scripts/build-wasm.sh                      # release WASM → web/public/engine.wasm
./scripts/build-worklet.sh                   # esbuild bundle → web/public/worklet/processor.js
```

TypeScript, from `web/` (pnpm, not npm):

```sh
pnpm dev                                     # Vite, with the COOP/COEP headers
pnpm test                                    # vitest, one run
pnpm test:watch
pnpm lint                                    # eslint, type-aware
pnpm format                                  # prettier --write
pnpm check                                   # svelte-check + tsc over all three projects
pnpm build:worklet                           # alias for ../scripts/build-worklet.sh
```

`scripts/build-wasm.sh` must be used instead of a bare `cargo build`: it forces the build from the workspace root (see profiles below), checks that the `wasm32-unknown-unknown` target is installed, and verifies via `node` that the compiled module still exports every ABI function plus `memory`. **When adding or renaming an exported ABI function, update the `expected` array in that script** — a lost `#[unsafe(no_mangle)]` otherwise produces a successful build and a silently useless module.

Both build artifacts — `web/public/engine.wasm` and `web/public/worklet/processor.js` — are gitignored and reproduced in full by their scripts. Neither is rebuilt by `pnpm dev`: the worklet is outside Vite's module graph, so **it must be rebuilt by hand after every edit to `src/worklet/`**. `pnpm test` fails loudly rather than skipping when `engine.wasm` is absent.

## Current state

The first milestone is the skeleton: a metronome computed in Rust, and nothing beyond it. Done: the Rust half (transport, command codec, ring decoding, metronome, C-ABI), the Vite host with COOP/COEP headers, and the worklet — the engine is instantiated on the audio thread and renders. Still missing: the SAB ring buffer, and the first sound. Nothing sends a command yet, so the transport never starts and the output is silence by construction.

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

### The ABI contract is mirrored, in both directions

Two shapes cross the ABI, each described twice — once per language — and each pair edited together. A mismatch produces silently wrong behavior that is very expensive to diagnose.

- **UI → audio, the 16-byte little-endian record:** `crates/engine/src/commands.rs` and `web/src/audio/protocol.ts`.
- **audio → UI, the telemetry block in linear memory:** the constants at the top of `crates/engine/src/engine.rs` and `web/src/worklet/telemetry-block.ts`.

The guards:

- `PROTOCOL_VERSION` — **its scope is both shapes**, and that is what makes it useful: a layout left outside its scope is one where neither check below fires and the symptom is wrong values rather than silence. Bump on any change to either.
- `engine_protocol_version()` is exported so the check compares against a number that came out of the *compiled engine*. The version field in the SAB header is written by the UI, so comparing it against `protocol.ts` compares JS with itself and proves nothing — what that one does catch is a worklet bundle that was not rebuilt.
- Four pinning tests, one per shape per language: `commands::tests::wire_format_is_pinned` and `protocol.spec.ts` for the record, `engine::tests::telemetry_layout_is_pinned` and `telemetry-block.spec.ts` for the block. Each asserts against literals rather than against the constants the code reads — a test that reads them agrees with whatever they say, which is why swapping two telemetry indices once left all sixty-nine Rust tests green. Any of the four failing is the signal to update both sides and bump the version.
- `tests/engine-abi.spec.ts` is the only place either shape is checked against the *compiled* artifact, in both directions.

There is deliberately no `engine_telemetry_words()`: the version check already refuses a mismatched build, and refuses it before the first quantum rather than after the field counts disagree.

Transport position is `u64` end to end, carried as two `u32` words (lo/hi) in both the protocol and the telemetry. On the JS side it stays a plain `number` (exact to 2^53); `BigInt` is not used anywhere.

### The TypeScript half splits by what a test can reach

`AudioWorkletProcessor` cannot be constructed outside a browser, and `registerProcessor` runs on import — so anything left inside `processor.ts` is code no test will ever run, and nothing can import out of it either. The split follows from that, not from taste:

- `worklet/processor.ts` — only what needs a browser: the class shape, the port, the render loop.
- `worklet/engine.ts` — bring-up as decisions. `openEngine` takes `EngineExports` rather than a `WebAssembly.Module` precisely so a fake can report the wrong version or refuse the arguments; the real artifact never will on demand.
- `worklet/render.ts` — the hot path, under different rules from everything around it.
- `audio/host.ts` — main-thread bring-up: compile, load, connect, and the check that the context actually reached `running`.
- `audio/protocol.ts` — the record format, the JS half of the first contract above. In `audio/` because both threads use it: the page encodes, the worklet copies.
- `worklet/telemetry-block.ts` — the block layout, the JS half of the second. In `worklet/` because the three contracts here divide by which memory each describes, and this one describes WASM linear memory, which only the audio thread ever addresses. By the same rule `audio/ring.ts` describes the SAB and is shared, and anything added later lands by asking the same question.

**Failures are values, not exceptions.** Forced, not stylistic: the processor constructor cannot let an exception escape — it would reach the page as a bare `processorerror` event carrying no reason at all — and on the page every failure presents identically, as silence, so the case has to survive to somewhere it can be described. Each side has a tagged error union and a `describe*` function whose `switch` has no `default`. `@typescript-eslint/switch-exhaustiveness-check` is on, and both unions are pinned again by a test keyed on `Record<Kind, …>`, so adding a case fails to compile in two places at once.

`engine.ts` and `host.ts` each declare their own `Result` rather than sharing one. They never exchange these values — different threads, neither calls the other — so a shared type would link them by name without linking anything real. The tests unwrap both through one structural helper, which is the only identity that has to hold.

**Nothing allocates in `renderQuantum`.** At 48 kHz that path runs 375 times a second on the one thread that must not collect garbage. `subarray` builds a new view object per call, which is why the whole-view copy is a separate branch and not a micro-optimisation; `render.spec.ts` spies on `Float32Array.prototype.subarray` to keep it that way.

**Tests are `*.spec.ts` and sit next to the module they cover. `src/` holds nothing else that is test-only** — support and fakes live in `web/tests/support/`, so what ships and what does not is visible from the path rather than inferred from a filename. `web/tests/` also holds the one spec with no module to sit beside: `engine-abi.spec.ts` instantiates the compiled wasm and checks it against the TypeScript mirrors in both directions — records written by the shipping encoder and read by the shipping decoder, and the telemetry block read back where `telemetry-block.ts` says it is. That is the part of the contract neither side can verify alone.

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

## Dependencies and license

The project is proprietary — all rights reserved, `LICENSE` at the root — and the repository is public only so the code can be read. Being public grants nothing: a license is a permission, and none is given.

That fixes what may be depended on. **Permissive licenses (MIT, Apache-2.0, BSD, ISC) and MPL-2.0 are fine. GPL, AGPL and LGPL are not.** The page ships its JavaScript and WASM to every visitor, and that is distribution — copyleft would then oblige us to hand each of them the source. LGPL's escape hatch, that the user be able to swap the library out, means nothing for a statically linked WASM module, so it goes with the rest.

Check the license before adding a dependency, not after; removing one later costs more than writing the thing did. Today the engine has zero dependencies and `web/` has none outside devDependencies, all of them permissive.

The one place this will bite is time-stretching on M7: Rubber Band is GPL-3.0 or a paid commercial license, SoundTouch is LGPL. That algorithm gets written here or bought — it is the only point on the roadmap where the license choice costs anything.

## Test style

Tests here are documentation of *why*, not just coverage. Test names are sentences and comments explain the failure being guarded against — match that style when adding to them.