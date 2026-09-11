---
paths:
  - "crates/core/**"
  - "crates/time/**"
  - "crates/worklet/**"
---

# The real-time thread

Enforced by nothing but discipline. Violating these tends to fail far from the
cause.

- **`escapement-core` runs on the real-time thread.** No allocation, locks,
  panics, I/O or logging on the processing path. Allocation is allowed only while
  building the graph, before playback. Adding a dependency that allocates
  internally breaks this invisibly — which is why the allocation half is checked
  twice, from both ends: `escapement-core`, `escapement-time` and
  `escapement-protocol` are `no_std`, so nothing in them can *name* a heap, and
  `tools/check-worklet-module.py` reads the built module for one, which is the
  half that reaches inside dependencies.
- **The worklet crate itself cannot be `no_std`, and this has been tried.** A
  `cdylib` without `std` wants its own `#[panic_handler]`, the dev profile's
  unwinding panics are unsupported without one, and the host `.dylib` then fails
  to link for want of a libc. The numbers are in
  `tools/check-worklet-module.py`'s docstring.
- **The worklet's module imports nothing, and a cargo feature is how that
  breaks.** `worklet.js` instantiates it with no import object, which is what
  makes `process()` ready on its first call (§1); a module with an import section
  cannot be instantiated that way at all. Reaching the region from the interface
  needs `js-sys`, so the outside half of the protocol is `escapement-view` — a
  crate the worklet does not depend on — and **never a feature on
  `escapement-protocol`**, because cargo unifies features across a workspace
  build. Measured with nothing even using it: 8568 bytes became 468 568, with
  four `__wbindgen` imports and an allocator. Checked by the same script.
- **The worklet's entry points hold no behaviour, only delegation.** A `static`
  exists once per process and `escapement_init` cannot be undone, so anything
  with a branch in it there can be tested once and never again — measured: with
  the `Some`/`None` of `escapement_process` still in `lib.rs`, a `panic!()` in
  the silence arm passed the entire suite, and cargo-mutants did not see it
  either. Behaviour lives in `module.rs` and `processor.rs`, which are handed
  their memory; `lib.rs` keeps three statics, five one-line exports and a single
  test over them. That test cannot be joined by a second — `cargo test` runs
  `#[test]`s on several threads and they would race — and **Miri does not cover
  this class at all**, since `cargo miri test` runs them one at a time.
- **Nothing on the processing path may panic, and an index into a slice is
  how that happens.** A panic that carries a message formats it, formatting
  builds a `String`, and a `String` is an allocator in the module that must not
  have one — so `tools/check-worklet-module.py` fails on a bounds check the
  optimizer could not discharge, a dozen calls away from the index that caused
  it. Measured 2026-09-11: one `&self.tempo[..self.marks]` in the engine, plus
  `into[index]` in `tempo::build` and the codec's slice indexing, pulled
  `dlmalloc` in whole. What holds instead: `get`/`get_mut` with an answer for
  the miss, and a slice narrowed to a fixed-size array once at the top of a
  codec so every index below it is one the compiler can discharge.
  **`clippy::indexing_slicing` is on in the four crates the module links**, so
  this is caught where it is written rather than in the built artifact. Where an
  index is genuinely discharged, the proof is a `const` assertion the expect
  points at — never a sentence. A test module allows the lint: there an index
  out of range is how a test fails.
- **The render quantum is 128 samples and cannot be changed.** Anything wanting
  larger windows (FFT, time-stretch) buffers internally across quanta.
- **Every implementation of `Samples` is held to `conformance::check`, and a new
  one joins it rather than growing tests of its own.** The trait is total — an
  index it does not like is silence, not an error — and that contract is kept in
  two crates at once. Written apart they drift, and did: the argument for
  guarding the frame index as well as the channel one was made in the worklet's
  tests and never reached the other, which left the offline render able to read a
  trailing sample the online path answers silence to. The suite is
  `escapement-core`'s `conformance` module, `#[doc(hidden)] pub` and generic
  rather than behind a feature, for the reason above.
- **Smoothing is measured in samples, never in blocks.** A gain ramp or a fade at
  a stop written "over one quantum" makes the engine's output depend on how long
  a block is, and the offline render for export chooses its own — so the file
  stops matching what was heard, with nothing wrong on either side to point at.
  `the_offline_render_of_*` in `escapement-worklet` compares the two paths sample
  for sample.
- **The transport has to be drivable from outside** — "start at position P at
  host time T", not only "play now" (§2.4). **Half true:** `Engine::start` takes
  P, and `Command.when` is still decoded and ignored, with the deferral reasoned
  at `Processor::apply`. Honouring T needs somewhere for a command that is not
  due to wait, and that somewhere is a preallocated structure the sequencer
  brings. What holds now is the half that shapes signatures: a transport method
  without a position is one that will have to grow one.
