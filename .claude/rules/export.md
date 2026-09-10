---
paths:
  - "crates/export/**"
---

# The render outside real time

- **There is one engine, and this crate is not a second one.** What it does is
  drive `escapement-core`'s in blocks of its own choosing (§7); anything here
  that shapes samples the online path does not shape is a fork of the engine,
  and it will not announce itself — a file that differs from what was heard
  looks like a file. **The tests that catch it are not in this crate.** They are
  in `escapement-worklet`, next to the online path they compare against, so a
  change here is unverified until that crate's tests have run.
- **The WAV encoder stays ours.** `hound` is the obvious dependency and its
  licence is not among the six `deny.toml` allows (`.claude/rules/licenses.md`).
  Where §5 takes a library rather than writing the DSP it is talking about
  stretching, not about a RIFF header of a few dozen lines.
