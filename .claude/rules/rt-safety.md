---
paths:
  - "crates/core/**"
  - "crates/time/**"
  - "crates/worklet/**"
---

# The real-time thread

Enforced by nothing but discipline. Violating these tends to fail far from the cause.

- **`escapement-core` runs on the real-time thread.** No allocation, locks, panics,
  I/O or logging on the processing path. Allocation is allowed only while building
  the graph, before playback. Adding a dependency that allocates internally breaks
  this invisibly — which is why the allocation half is checked twice, from both
  ends. `escapement-core`, `escapement-time` and `escapement-protocol` are
  `no_std`, so nothing in them can *name* a heap; and
  `tools/check-worklet-module.py` reads the built module for one, which is the
  half that reaches inside dependencies.
  The worklet crate itself cannot be `no_std`: a `cdylib` without `std` wants its
  own `#[panic_handler]`, the dev profile's unwinding panics are unsupported
  without `std`, and the host `.dylib` then fails to link for want of a libc.
  Measured, not assumed — the script's docstring carries the numbers.
- **The worklet's module imports nothing, and a cargo feature is how that
  breaks.** `worklet.js` instantiates it with no import object, which is what
  makes `process()` ready on its first call (§1); a module with an import
  section cannot be instantiated that way at all. Reaching the region from the
  interface needs `js-sys`, so the outside half of the protocol is
  `escapement-view` — a crate the worklet does not depend on — and **never a
  feature on `escapement-protocol`**: cargo unifies features across a workspace
  build, so it would be on in the worklet's copy of the crate too. Measured
  before the split, with nothing even using it: four `__wbindgen` imports, an
  allocator, and 8568 bytes became 468 568. Checked by the same script.
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
- **Every implementation of `Samples` is held to `conformance::check`, and a
  new one joins it rather than growing tests of its own.** The trait is total —
  an index it does not like is silence, not an error — and that contract is kept
  in two crates at once: `Frames` over a slice, `Published` over the region.
  Written apart they drift, and did: the argument for guarding the frame index
  as well as the channel one was made in the worklet's tests and never reached
  the other, which left the offline render able to read a trailing sample the
  online path answers silence to. The suite is `escapement-core`'s `conformance`
  module — `#[doc(hidden)] pub` and generic rather than behind a feature, for
  the reason above, and so nothing of it reaches a module that does not call it.
  The third implementation is coming, when frames stream from a worker (§5).
- **Smoothing is measured in samples, never in blocks.** A gain ramp or a fade
  at a stop written "over one quantum" makes the engine's output depend on how
  long a block is, and the offline render for export chooses its own — so the
  file stops matching what was heard, with nothing wrong on either side to point
  at. `the_offline_render_of_*` in `escapement-worklet` compares the two paths
  sample for sample, and a fade written per block was measured against them and
  caught.
- **The transport must be drivable from outside** — the engine accepts "start at
  position P at host time T", not only "play now". Needed for follow mode later.
