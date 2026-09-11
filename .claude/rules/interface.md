---
paths:
  - "crates/app/**"
  - "crates/render/**"
  - "crates/view/**"
---

# The interface

- **`escapement-render` must not depend on the UI framework.** State in, mouse
  events out, no Leptos types in its public API. This is the only decision in the
  project that is deliberately kept reversible.
- **A tab that is not in front has almost no frames, so the interface almost
  stops sending.** Chrome pauses `requestAnimationFrame` in a hidden tab and
  throttles it hard in a visible one that is not in front, while the interface's
  outbox is drained once a frame (§3). Measured: 60 a second in front, 0 in
  800 ms hidden — and **15 frames in three minutes in a tab that was neither**,
  which is the case to design against, because a page in that state looks alive
  while its queue stands still. Harmless for a person, who is not clicking at a
  tab they cannot see; not harmless for anything that sends on a timer, nor for a
  control whose value the engine has not been told yet — that is how an export
  comes out different from what is playing. The audio thread is unaffected: it
  runs off the audio clock, not off frames.
- **The page hands the export material and a rate, and nothing else.** What the
  engine is set to it reads out of the region itself, because the page's copy is
  what the engine was *told* — and the engine may have refused it
  (`.claude/rules/protocol.md`). The controls are inputs, not a record of what is
  playing, and a wrapper here that takes one as an argument puts the whole
  divergence back.
- **Nothing on the host reaches these crates.** `escapement-view` implements
  `Cells` over a typed array — four of its five methods are `Atomics` calls and
  the fifth the array's length — and `escapement-app`'s memory is only shared
  once a browser has instantiated the module. A change here is unverified until the
  browser line in `CLAUDE.md` has run.
