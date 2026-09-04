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
cargo test -p escapement-core nyquist               # a single test
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all --check                             # CI enforces this
cargo deny check licenses bans sources              # what may be shipped
cargo build --workspace --target wasm32-unknown-unknown --release
python3 tools/check-shared-memory.py target/wasm32-unknown-unknown/release/*.wasm
python3 tools/check-shared-memory.py --fixed target/wasm32-unknown-unknown/release/escapement_worklet.wasm
python3 tools/check-worklet-module.py target/wasm32-unknown-unknown/release/escapement_worklet.wasm

cargo test -p escapement-view -p escapement-app --target wasm32-unknown-unknown   # Atomics, in a browser

tools/miri.sh -p escapement-protocol -p escapement-worklet   # undefined behaviour, data races
RUSTFLAGS="--cfg loom" cargo test -p escapement-protocol   # memory orderings
cargo mutants -p escapement-protocol --timeout 10   # do the tests test anything
tools/mutants.py check              # do its two runs still cover everything

trunk serve                     # :8080 — the slice, worklet built by a hook
tools/dev-server.py dist        # the same build with Trunk out of the way
```

The `full-check` skill runs all of this in the order CI does, with what each
step catches and when a failure is the runner rather than the code.

The toolchain — pinned nightly, wasm target, the `rust-src` component
`build-std` needs, and `miri` — comes from `rust-toolchain.toml`; `rustup show`
installs it, and nothing else is needed to build. Trunk is in the chain now and
owns `dist`; `tools/build-worklet.sh` runs as its pre-build hook, because the
worklet has to come out as raw wasm and Trunk's rust pipeline gives the
opposite.

The browser line is not a convenience: `escapement-view` reaches the region with
`Atomics` over a typed array, and there is no `Atomics` on the host, so nothing
else can reach it. Both crates are on that line, and the second for a reason of
its own — whether `escapement-app`'s memory came out shared is answered by a
module a browser has instantiated, and by nothing earlier. It needs two host
tools — `cargo +stable install wasm-bindgen-cli --version 0.2.127`, whose
version must match the `wasm-bindgen` crate in `Cargo.lock`, and `brew install
--cask chromedriver`, whose major version must match the installed Chrome.
`.cargo/config.toml` names the runner; the runner serves with the isolation
headers itself, so `SharedArrayBuffer` is real there.

## Invariants that break things silently

They are enforced by nothing but discipline, and violating them tends to fail far
from the cause — so each one now lives beside the files it governs, in
`.claude/rules/`, and is loaded when those files are read rather than in every
session:

| Rule | Governs | What it holds |
|---|---|---|
| `rt-safety.md` | `crates/core`, `crates/worklet` | No allocation, locks, panics or I/O on the processing path; the module that must import nothing; entry points without behaviour; the 128-sample quantum; a transport drivable from outside |
| `protocol.md` | `crates/protocol`, `crates/view` | Nothing at frame rate through `postMessage`; no cargo feature on the crate both modules link; the fences Loom must see; two `cfg` attributes and never one `all(...)`; why a throw out of `Atomics` is not an error you can catch |
| `interface.md` | `crates/app`, `crates/render`, `crates/view` | `escapement-render` stays free of the UI framework; a hidden tab sends nothing; neither crate is tested anywhere but a browser |
| `musical-time.md` | `crates/time`, `crates/model`, `crates/core` | Positions in musical time, tempo as a map with ramps |
| `model.md` | `crates/model` | The document is a CRDT from the first struct; reordering through a movable list; a pattern is referenced, not copied; undo belongs to its author; what stays out of the document |
| `wasm-build.md` | `crates/*/build.rs`, `.cargo/config.toml`, `Trunk.toml`, `web/` | `+atomics` is not shared memory; fixed memory against growing; `build-std` against `cargo miri`; and the rest of the build configuration |
| `licenses.md` | `Cargo.toml`, `deny.toml` | No whole-program copyleft, ever |
| `checks.md` | `tools/`, `.github/workflows/` | What Miri, Loom and the two mutation runs cost, and why they are shaped that way |

A rule is a home, not a copy: when one of them is what a change is about, it is
the file to edit, and this table is only the index.

## Where a reason goes

Four permanent homes, and a reason belongs to exactly one. Without the rule each
one lands in the nearest, which is always the comment — that is where you are
typing — and the code fills up with the project's history.

| The reason is | Home |
|---|---|
| this must not be done, it breaks silently | this file, or the rule in `.claude/rules/` that governs those files |
| the product is shaped this way, and here is what was rejected | `ARCHITECTURE.md` |
| this is how we found out — a measurement, an experiment, a failed attempt | the commit message |
| this is what you need in order to edit this line | the comment |

So a comment does not carry the number that justified a choice already made, does
not narrate the change that introduced it, and does not retell a section it could
point at — the `ARCHITECTURE.md §3` idiom is there for that.

Nothing checks this. A script can catch the narrowest corner of it — prose
copied word for word out of one of the documents — and that is not where the
weight is: the essays that grow are restatements, and a check that reads as
coverage while missing them is worse than none.

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
| RT **and** UI | `protocol` | The shared region itself — header, command ring, state block. The one crate linked into both wasm modules, so both ends decode what the other encoded (§3) |
| UI, workers | `view` | How that region is reached from outside the memory that holds it: `Atomics` over a typed-array view. Apart from `protocol` because it needs `js-sys`, which must not reach the worklet |

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

## Work order

Four vertical slices, each closing one risk (`ARCHITECTURE.md` §7): audio path →
CRDT on Loro → patterns → warp. Slices 1 and 2 can run in parallel. The pattern
model outranks warping because patterns are the product's identity.

## Branches

Two prefixes, and the split is between product and plumbing:

- `feature/` — anything that changes what the product does: the slices above, the
  engine, the UI, the model.
- `chore/` — toolchain, CI, scripts, dependencies, documentation. No product
  behaviour changes.

Nothing else until there is something to put in it. The descriptive half carries
the meaning — `chore/wasm-shared-memory`, not `chore/build-fixes`.

## Contributions

External changes require a signed CLA, and the CLA bot is **not set up yet** — see
`CONTRIBUTING.md`. Until it is, external PRs cannot be accepted.
