---
paths:
  - "crates/protocol/**"
  - "crates/view/**"
---

# The shared region and how it is checked

- **Never send frame-rate data through `postMessage`.** Meters, playhead position
  and transport state go into a fixed `SharedArrayBuffer` region that the UI polls
  each frame. Messages carry only user commands and structural model changes.
- **`Command.when` is a sample count on the engine's clock, never a musical
  position** (§3). A position crosses as the payload of a command that carries a
  place in the song — "start at position P at time T" is two values, and `when`
  is T. The audio thread has no tempo map to resolve a musical moment with, and
  `0` already means *as soon as it is seen*, which on a musical scale is bar one.
- **The frames go into the audio buffer *before* the command that names them,
  and nothing else orders them** (§3). The buffer has no counter of its own, on
  purpose: what carries the frames across is the release on the ring's tail and
  the acquire on the far side. Fill it after sending, or reach it by any path
  that is not the ring, and both halves still compile, the descriptor is still
  valid, and what plays is whatever was in those words — most of the time the
  right thing, because the ring is drained a quantum later. Reading a frame is a
  *relaxed* load rather than an ordinary one for the same reason the state
  block's payload is: the other side writes these words, and a race on a
  non-atomic access is undefined behaviour in Rust's model even where every
  value it could return would have been fine.
- **Ordering is only half of it: the words a live descriptor covers belong to
  the engine.** Publishing twice into the same words is not a missing release —
  it is a second writer arriving while the first frames are still being read,
  and it sounds like both files at once. So a publication carries a number, the
  engine echoes back the one it is playing from
  (`EngineState::audio_publication`), and **the interface writes into the half
  of the buffer that is not live and waits for the echo before reusing the
  other**. The echo is also how a refusal is reported: a descriptor the engine
  turns away leaves it where it was, which says both *that* one was refused and
  *which* words are still being read.
- **A descriptor out of the region is checked before it is believed, and the
  check has two steps that can each overflow.** `usize` is 32 bits on the
  target, so a frame count times a channel count, and then an offset added to
  that, reach past what it holds long before they reach the comparison that
  would have turned them away — both are `checked_`. A host test cannot catch
  this: there `usize` is 64 bits and the same arithmetic simply fits. The same
  descriptor is checked against what a quantum can afford, which the buffer's
  size does not bound: one frame costs a read per channel, so a single frame of
  as many channels as the buffer has words is a million reads inside 2.7 ms.
  `escapement-core`'s `MAX_SOURCE_CHANNELS` is that ceiling, and it lives there
  because the budget is the engine's rather than the region's.
- **Never put a cargo feature on `escapement-protocol`.** Features unify across a
  workspace build, so one added for the interface arrives in the worklet's copy
  too, and the worklet's module must import nothing. The measurement is in
  `.claude/rules/rt-safety.md`; the outside half of the protocol is
  `escapement-view`, which is where `js-sys` is allowed to be.
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
  surviving. Measured on cargo-mutants 27.1.0: 147 mutants becomes 182. There is
  no option for it — `--exclude` matches files and `--exclude-re` mutant names,
  neither knows about `cfg` — and the collapsed form compiles and passes CI, so
  nothing but this note is in the way of tidying it up.
- **A throw out of `Atomics` does not unwind.** `unwrap_throw` on a failed
  `Atomics` call throws into JavaScript, and a JS exception crossing wasm frames
  runs no destructors — a `RefCell` borrow open at the time is never given back,
  and every frame after it panics on that borrow rather than on what went wrong.
  So an index has to be known inside the region before it is used, which is why
  `Layout::read_header` asks `Cells::words()` before it reads the magic.
