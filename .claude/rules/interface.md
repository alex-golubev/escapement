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
- **A hidden tab has no frames, so the interface stops sending.** Chrome pauses
  `requestAnimationFrame` in a tab that is not visible, and the interface's
  outbox is drained once a frame (§3) — so while the tab is hidden, commands
  queue and nothing leaves. They go when it comes back. Harmless for a person,
  who is not clicking at a tab they cannot see; not harmless for anything that
  ever sends on a timer, which would appear to work and silently not. Measured:
  0 frames in 800 ms hidden, 60 a second visible. The audio thread is unaffected
  — it runs off the audio clock, not off frames.
- **Nothing on the host reaches these crates.** `escapement-view`'s five `Cells`
  methods are `Atomics` calls, and `escapement-app`'s memory is only shared once
  a browser has instantiated the module. A change here is unverified until the
  browser line in `CLAUDE.md` has run.
