# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Read ARCHITECTURE.md first

This repo is currently a **skeleton with no implementation**. Nearly all of its
substance lives in `ARCHITECTURE.md` (~1000 lines): the decisions, the reasoning,
and — importantly — which decisions are irreversible.

Several choices are explicitly one-way doors (CRDT-shaped project model, FL-shaped
entities, musical time, RT-safe engine). Making a design choice here without
reading that document risks silently invalidating one of them. Section numbers
(§2.4, §5.1, …) referenced in code comments point into it.

## Commands

```sh
cargo test --workspace                              # tests
cargo test -p escapement-core render_quantum        # a single test
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all --check                             # CI enforces this
cargo build --workspace --target wasm32-unknown-unknown --release

trunk serve      # dev server on :8080, serves the required COOP/COEP headers
```

First-time setup: `rustup target add wasm32-unknown-unknown && cargo install trunk`.
The toolchain is pinned in `rust-toolchain.toml`.

## Invariants that break things silently

These are enforced by nothing but discipline. Violating them tends to fail far from
the cause.

- **`escapement-core` runs on the real-time thread.** No allocation, locks, panics,
  I/O or logging on the processing path. Allocation is allowed only while building
  the graph, before playback. Adding a dependency that allocates internally breaks
  this invisibly.
- **`escapement-render` must not depend on the UI framework.** State in, mouse
  events out, no Leptos types in its public API. This is the only decision in the
  project that is deliberately kept reversible.
- **No GPL/AGPL dependencies, ever.** Shipping a wasm bundle to a browser is
  distribution, so a GPL dependency would force the whole product to be GPL. This
  is why time-stretch is Signalsmith rather than Rubber Band.
- **Positions are stored in musical time, never in samples.** Tempo is a map with
  ramps, not a number.
- **Never send frame-rate data through `postMessage`.** Meters, playhead position
  and transport state go into a fixed `SharedArrayBuffer` region that the UI polls
  each frame. Messages carry only user commands and structural model changes.
- **The render quantum is 128 samples and cannot be changed.** Anything wanting
  larger windows (FFT, time-stretch) buffers internally across quanta.
- **The transport must be drivable from outside** — the engine accepts "start at
  position P at host time T", not only "play now". Needed for follow mode later.

## Architecture

The whole client is Rust compiled to wasm. There is no JavaScript layer.

Work is split **by thread**, not by language, and the split is the thing to
understand before editing:

| Thread | Crate | Responsibility |
|---|---|---|
| RT (AudioWorklet) | `core`, `worklet` | Audio graph, DSP, mixer, sample playback, stretch synthesis |
| Model | `model` | CRDT project document (Loro), undo/redo, sequencer, automation |
| Workers | — | Disk streaming, decoding, waveform peaks, warp analysis |
| UI | `app`, `render` | Leptos panels; WebGL2 canvas for playlist and piano roll |

**Two separate wasm instances.** The worklet has its own linear memory and cannot
see the UI thread's. All exchange crosses `SharedArrayBuffer` ring buffers, even
though both sides are Rust. What Leptos removes is the *language* boundary, not the
*thread* boundary — the ring protocol is simply written once instead of twice.

The model thread publishes an immutable snapshot to the audio thread via double
buffering, so the RT thread never waits and never reads mutating structures.

**Multiplayer is the product's axis of differentiation**, not a feature. The project
model is a CRDT from day one; the network layer comes later. Loro was chosen for
explicit movable lists — reordering tracks concurrently under a naive list CRDT
duplicates or loses them.

The sync service (relay, asset storage, accounts) is **not in this repository** and
is closed source; the engine is open.

## Build configuration worth knowing

- `.cargo/config.toml` enables `+simd128`. The **atomics flags are commented out**
  and must be enabled together with nightly + `build-std` when `SharedArrayBuffer`
  work starts (slices 1 and 2). The skeleton currently builds on stable.
- COOP/COEP headers are mandatory for `SharedArrayBuffer`. Configured in
  `Trunk.toml` for dev; production hosting must send the same. Without them the
  failure looks like broken wasm rather than a missing header.
- `escapement-app` is built with `opt-level = "s"`; everything else with `3` + LTO.

## Work order

Four vertical slices, each closing one risk (`ARCHITECTURE.md` §7): audio path →
CRDT on Loro → patterns → warp. Slices 1 and 2 can run in parallel. The pattern
model outranks warping because patterns are the product's identity.

## Contributions

External changes require a signed CLA, and the CLA bot is **not set up yet** — see
`CONTRIBUTING.md`. Until it is, external PRs cannot be accepted.
