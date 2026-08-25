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
cargo build --workspace --target wasm32-unknown-unknown --release
python3 tools/check-shared-memory.py target/wasm32-unknown-unknown/release/*.wasm
python3 tools/check-shared-memory.py --fixed target/wasm32-unknown-unknown/release/escapement_worklet.wasm
python3 tools/check-worklet-module.py target/wasm32-unknown-unknown/release/escapement_worklet.wasm

tools/miri.sh -p escapement-protocol -p escapement-worklet   # undefined behaviour, data races
RUSTFLAGS="--cfg loom" cargo test -p escapement-protocol   # memory orderings
cargo mutants -p escapement-protocol --timeout 10   # do the tests test anything

tools/build-first-sound.sh              # worklet + dist-first-sound/
tools/dev-server.py dist-first-sound    # :8080 with the COOP/COEP headers
```

The toolchain — pinned nightly, wasm target, the `rust-src` component
`build-std` needs, and `miri` — comes from `rust-toolchain.toml`; `rustup show`
installs it, and nothing else is needed to build. Trunk is configured but not in
the chain yet, so `trunk serve` gets you `web/index.html` — the empty Leptos
client — rather than the slice above.

**Miri takes a crate list, never `--workspace`.** It interprets rather than runs,
so its cost follows the code put under it, and only `unsafe` or a deliberate race
gives it anything to find. Measured: `escapement-core` contains no `unsafe` at
all and costs 36 s against the protocol's 23, because its tests push 48 000
samples through a sine one sample at a time. The worklet costs 8 s and earned
its place on the first run, on a test that took a pointer into a `Box` and then
moved the `Box` — undefined behaviour that every ordinary run passed.

CI runs all three. Miri and Loom are jobs beside the ordinary checks rather than
steps inside them, so they add waiting time only if they turn out to be the
slowest thing — they pay in runner minutes instead. Mutation testing runs
`--in-diff` against the base branch: a full run grows as (number of mutants) x
(time to run the tests) and would not stay affordable, while a diff-scoped one
follows the size of the change (measured on this branch: 18 mutants instead of
144). Mutants that survive by construction rather than by a gap in the tests are
listed in `.cargo/mutants.toml`, one narrow regex each.

## Invariants that break things silently

These are enforced by nothing but discipline. Violating them tends to fail far from
the cause.

- **`escapement-core` runs on the real-time thread.** No allocation, locks, panics,
  I/O or logging on the processing path. Allocation is allowed only while building
  the graph, before playback. Adding a dependency that allocates internally breaks
  this invisibly — which is why the allocation half is checked twice, from both
  ends. `escapement-core` and `escapement-protocol` are `no_std`, so nothing in
  them can *name* a heap; and `tools/check-worklet-module.py` reads the built
  module for an allocator, which is the half that reaches inside dependencies.
  The worklet crate itself cannot be `no_std`: a `cdylib` without `std` wants its
  own `#[panic_handler]`, the dev profile's unwinding panics are unsupported
  without `std`, and the host `.dylib` then fails to link for want of a libc.
  Measured, not assumed — the script's docstring carries the numbers.
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
- **`+atomics` alone does not give you shared memory.** The feature flag makes
  atomic instructions available but still links a *private* memory; shared memory
  must be requested from the linker (`--shared-memory`, legal only with
  `--max-memory`). Dropping those link args still builds, still produces valid
  wasm, and fails only in the browser — pointing at the wasm rather than at the
  flag. `tools/check-shared-memory.py` guards this in CI.
- **The worklet's memory is fixed and the UI's grows**, so their link args live in
  `crates/*/build.rs`, not in `.cargo/config.toml` — `rustflags` there apply to
  every crate built for the target and cannot tell the two apart. `memory.grow` is
  not bounded and a quantum is 2.7 ms, so the worklet links `--initial-memory`
  equal to `--max-memory` (§1); shared memory reserves its maximum up front
  regardless, so growth would buy nothing. Note this is *not* about stale views —
  growing a **shared** memory keeps them valid, unlike a private one. CI checks it
  with `--fixed`.
- **`build-std` and `cargo miri` collide.** `build-std` engages whenever
  `--target` is passed, and `cargo miri` passes one — for the host. Miri builds
  its own sysroot as well, and the two fight over `core`. It fails inside
  `compiler_builtins` with hundreds of "cannot find `Some` in this scope", which
  points nowhere near the cause. Cargo finds `.cargo/config.toml` by walking up
  from the *working directory*, not from the manifest, so `tools/miri.sh` runs
  from outside the repository and points cargo back at it.
- **Loom only sees what goes through Loom's types**, and it must see the *same*
  code that ships. A `core::sync::atomic::fence` is invisible to it, so it
  explores interleavings the real fence forbids and reports a failure that is not
  there — looking exactly like a torn read. So `Cells::fence_release` and
  `fence_acquire` pick their fence with `cfg(loom)` and are **not overridden** by
  the Loom backend: an override would have the model checking a different
  function from the one in the bundle, which is worse than not checking at all.
  A fence has no effect any single-interleaving test can observe, so Loom is the
  only thing covering them — mutation testing reports both as surviving, and
  that is expected rather than a gap.
- **Test modules carry two `cfg` attributes, never one `all(...)`.**
  `#[cfg(test)]` and `#[cfg(not(loom))]` on separate lines. `cargo-mutants`
  parses the source without evaluating `cfg` and recognises only a bare
  `#[cfg(test)]` as test code, so written as `#[cfg(all(test, not(loom)))]` it
  mutates modules an ordinary build never compiles — `access/loom.rs`,
  `access/testing.rs`, `interleavings.rs` — and reports those mutants as
  surviving. Measured on cargo-mutants 27.1.0, which is current: 147 mutants
  becomes 182. There is no option for it — `--exclude` matches files and
  `--exclude-re` mutant names, neither knows about `cfg` — and the collapsed
  form compiles and passes CI, so nothing but this note is in the way of
  tidying it up.
- **The worklet's entry points hold no behaviour, only delegation.** A `static`
  exists once per process and `escapement_init` cannot be undone, so anything
  with a branch in it there can be tested once and never again — measured: with
  the `Some`/`None` of `escapement_process` still in `lib.rs`, a `panic!()` in
  the silence arm passed the entire suite, and cargo-mutants did not see it
  either. So behaviour lives in `module.rs` and `processor.rs`, which are handed
  their memory, and `lib.rs` keeps three statics and five one-line exports with a
  single test over them. That test cannot be joined by a second: `cargo test`
  runs `#[test]`s on several threads and they would race — two failures in
  twenty runs, measured — and **Miri does not cover this class at all**, since
  `cargo miri test` runs the tests one at a time. Nothing enforces the rule; what
  keeps it true is that there is nothing left in `lib.rs` worth a second test.
- **The render quantum is 128 samples and cannot be changed.** Anything wanting
  larger windows (FFT, time-stretch) buffers internally across quanta.
- **The transport must be drivable from outside** — the engine accepts "start at
  position P at host time T", not only "play now". Needed for follow mode later.

## Where a reason goes

Four permanent homes, and a reason belongs to exactly one. Without the rule each
one lands in the nearest, which is always the comment — that is where you are
typing — and the code fills up with the project's history.

| The reason is | Home |
|---|---|
| this must not be done, it breaks silently | this file |
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

- `.cargo/config.toml` enables `+simd128` and `+atomics,+bulk-memory,+mutable-globals`
  for the whole target — they change the ABI, so every crate in the link must agree.
  Memory link args are per crate in `crates/*/build.rs`. The toolchain is a **pinned
  dated nightly** — atomics-enabled wasm needs std rebuilt from source
  (`build-std`), which is nightly-only. The pin is dated on purpose: CI runs clippy
  with `-D warnings`, and a floating nightly reddens untouched trees.
- `build-std` only engages when `--target` is passed explicitly, so host builds and
  `cargo test` keep using the prebuilt std and stay fast.
- **Install host tooling with `cargo +stable install`** — `cargo +stable install
  trunk`, never plain `cargo install trunk`. Run inside the repo, `cargo install`
  picks up the pinned nightly and builds the tool with it; trunk's dependency
  `lightningcss` does not compile there. Trunk is a host binary and has nothing
  to do with the wasm toolchain.
- **The slice 1 probe and Trunk do not share an output directory.** Trunk owns
  `dist` and clears it on every build; `tools/build-first-sound.sh` assembles
  `dist-first-sound/` by hand. One directory would make `index.html` whichever of
  the two ran last, with `tools/dev-server.py` serving it and saying nothing.
- COOP/COEP headers are mandatory for `SharedArrayBuffer`. Sent by
  `tools/dev-server.py`, which is what serves the probe today, and configured in
  `Trunk.toml` for when Trunk takes over; production hosting must send the same.
  Without them the failure looks like broken wasm rather than a missing header.
- `escapement-app` is built with `opt-level = "s"`; everything else with `3` + LTO.

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
