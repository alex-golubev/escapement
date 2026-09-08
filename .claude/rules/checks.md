---
paths:
  - "tools/**"
  - ".github/workflows/**"
  - ".cargo/mutants.toml"
---

# What the checks cost and why they are shaped this way

To run them, use the `full-check` skill. This file is for editing them.

**Miri takes a crate list, never `--workspace`.** It interprets rather than runs,
so its cost follows the code put under it, and only `unsafe` or a deliberate race
gives it anything to find. Measured: `escapement-core` contains no `unsafe` at
all and costs 36 s against the protocol's 23, because its tests push 48 000
samples through a sine one sample at a time. The worklet costs 8 s and earned
its place on the first run, on a test that took a pointer into a `Box` and then
moved the `Box` — undefined behaviour that every ordinary run passed.

**Loom's cost follows the payload, and not linearly.** The state block's model
branches on every value a relaxed load could return, so a word added to
`EngineState` is not a word added to the run: going from eight to nine took the
crate's two models from 21 s to 48 s, measured either side of the commit that
added the publication echo. `preemption_bound = 3` is what keeps it a number at
all — unbounded, the same model was still running after half an hour. A tenth
word is worth measuring before it is added rather than after.

CI runs all three. Miri and Loom are jobs beside the ordinary checks rather than
steps inside them, so they add waiting time only if they turn out to be the
slowest thing — they pay in runner minutes instead. Mutation testing runs
`--in-diff` against the base branch: a full run grows as (number of mutants) x
(time to run the tests) and would not stay affordable, while a diff-scoped one
follows the size of the change (measured on the branch that introduced it: 18
mutants instead of 144). Mutants that survive by construction rather than by a
gap in the tests are listed in `.cargo/mutants.toml`, one narrow regex each —
and the bar for adding one is in that file's own header.

It takes **two runs, and they are only correct as a pair.** What tests
`escapement-view` and `escapement-app` is a browser, so on a host run their
mutants survive with nothing wrong with them; those two crates are left to a
second run against the wasm target instead. Neither half shows that the other
exists, which is how a third crate could later be dropped from one and never
added to the other, and nothing would say so. `tools/mutants.py` owns the split
and `tools/mutants.py check` is what asks whether the halves still add up: it
prints all three counts and fails unless two of them make the third. The counts
move with every commit that adds code, which is why they are measured there
rather than remembered here.
