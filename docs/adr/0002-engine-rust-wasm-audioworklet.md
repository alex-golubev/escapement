# ADR-0002. Audio engine: Rust → WASM in an AudioWorklet

- Status: accepted
- Date: 2026-09-17

## Context

We need a fast, predictable audio engine in the browser. The audio thread has a hard budget: at 48 kHz a block of 128 samples has 2.67 ms, and missing it means an audible click. A garbage collector pause does not fit in that budget, so the engine is written in a language without one. Rust gives us that together with memory safety, without going fully manual as in C or C++.

Our experience with Loro and yrs showed that a Rust panic inside WASM breaks the instance, with no orderly way to recover from the JS side ([ADR-0003](0003-crdt-yjs.md)). Our engine is Rust too, so the same risk applies to us.

## Decision

### Structure

- `engine-core` — the platform-independent core.
- `engine-wasm` — the AudioWorklet host.
- `engine-native` — the native host: tests without a browser, server-side rendering, groundwork for a desktop build.
- The WASM module is compiled on the main thread and handed to the worklet as a ready `WebAssembly.Module`: there is no `fetch` in AudioWorkletGlobalScope.

### Talking to the UI

- Lock-free ring buffers over SharedArrayBuffer:
  - commands travel from the main thread to the engine;
  - the engine writes meter levels and playback position into shared memory, and the UI reads them every frame.
- No `postMessage` in the hot path.
- The ring layout and the command slot format are described by a single declarative schema from which code is generated for both sides ([ADR-0011](0011-engine-boundary-schema.md)). Offsets and enum values are never written by hand in TS.
- The command decoder returns a `Result`: a malformed command is dropped and logged, and the engine stays up. The decoder is checked with `cargo-fuzz` against the native build.

### Real-time rules

- No allocations, no locks and no panics in `process`. In debug builds `assert_no_alloc` checks this.
- Voices and buffers are pre-allocated in pools.
- In `engine-core` the clippy lints `unwrap_used`, `expect_used`, `indexing_slicing` and `panic` are errors.
- Denormals are handled manually: FTZ/DAZ cannot be enabled in WASM.
- We use SIMD (`simd128`).
- Only our own code, with minimal dependencies, runs in the AudioWorklet. Third-party crates (decoders such as symphonia, resamplers, time-stretch) run in separate workers with their own WASM instances. A panic there kills only the worker: we restart it and retry the task.

### Crash recovery

1. A trap in `process()` surfaces as a `WebAssembly.RuntimeError`. We catch it, output silence and report to the main thread.
2. The main thread recreates the AudioWorkletNode with a fresh instance.
3. The new engine loads its state from the document ([ADR-0001](0001-document-source-of-truth.md)).
4. `console_error_panic_hook` is wired up for diagnostics and the crash report goes to the server.

### Threads

- At launch all rendering happens on the single AudioWorklet thread. Heavy work (decoding, time-stretch, offline export) runs in workers.
- A multi-threaded mixer on wasm threads comes later. For Rust that still requires nightly and `build-std`.

### Memory

- wasm32 caps out at 4 GB. Five minutes of stereo at 48 kHz in f32 is about 115 MB, so the sample pool needs real thought.

### Determinism

- The render is fully determined by the document plus asset and plugin versions. Random seeds are stored in the document.

### Other

- The engine compensates for plugin and effect latency (PDC).
- The engine can render part of a project offline (a channel, a pattern, a range) with metrics: loudness, spectrum. This is needed for export, freezing and later for AI ([ADR-0007](0007-domain-operations.md)).
- Plugins are attached through the contract in [ADR-0008](0008-plugins.md).

## Consequences

- SharedArrayBuffer requires cross-origin isolation (COOP/COEP), see [ADR-0010](0010-chromium-only.md).
- One engine codebase runs in the browser, in tests and on the server.
- An engine crash costs the user a brief dropout, not their work.
- The real-time rules demand discipline and dedicated tooling to enforce them.
- While rendering is single-threaded, the performance ceiling is lower than in native DAWs.

## Alternatives considered

- **A JS/TS engine in the AudioWorklet.** A garbage collector in the audio thread, and lower performance.
- **A graph of standard Web Audio API nodes.** Too little control over processing order; routing, sidechain and PDC are hard to build.
- **`postMessage` instead of SAB.** Allocations and latency on every message.
