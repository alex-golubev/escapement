# ADR-0021. Mutation testing

- Status: accepted
- Date: 2026-09-19
- Amends the tests and CI jobs of [ADR-0014](0014-tooling-and-ci.md)

## Context

A green suite proves that the tests ran, not that they would notice the
code changing. Two mutation runs over the generator said which of ours
catch something, and both found holes review had walked past:

- the `play` golden vector was `0x00000000` and `0xffffffff`, values
  that read the same backwards, so a writer that dropped the
  little-endian flag passed the one test written to catch it;
- `readCommandSlot` was reached by no test at all;
- the Rust writer's stride for an array field, `offset + n * size`, is
  exercised by no command the schema has, so neither the tests nor CI
  would have seen `n / size`;
- the `Atomics` index — one of the three things
  [ADR-0013](0013-boundary-code-generation.md) says are written wrong
  exactly once by hand — was asserted nowhere. The call sites were
  tested, the index inside them was not;
- the ABI version word has stood at major 0 since it was written, and at
  0 the shift and the mask are both invisible: every way of combining
  them gives the same number.

One finding is about CI rather than about a test. The `boundary` job
regenerates and fails on a difference, which says nothing about a
generator that writes nothing at all: it compares the committed files
with themselves. A mutation run is what noticed.

The cost, measured on this workspace on 2026-09-19: 253 mutants, four
minutes on a laptop, with the generator's own 224 of them taking three.
The number that matters is mutants × (build + test), and it grows with
the engine rather than with the schema.

The TypeScript half has a tool of its own, and Stryker's Vitest runner
is broken on the Vitest 5 this workspace is pinned to: the per-test
filter it sets matches no test at all, so every mutant comes back
surviving (stryker-js#6210, fix open and unreleased). Its command runner
switches a mutant on through the environment and runs the suite whole,
and that does work — 109 mutants over `packages/protocol/src`, 103
killed and six survivors in fifteen seconds.

Equivalent mutants exist on both sides. In
`(major << 24) | (hash & 0x00ff_ffff)` the operands share no bit, so OR
and XOR write the same word for every input. In the generated
TypeScript, `slot + CommandSlotOffsets.kind` has an offset of zero, and
the byte-order flag on a write of zero says nothing either way. No test
can tell any of them apart.

## Decision

- **`cargo-mutants` 27.1.0 and `@stryker-mutator/core` 10.0.0**, pinned
  like every other tool ([ADR-0014](0014-tooling-and-ci.md)).
  `cargo-mutants` reaches CI as a prebuilt binary through a SHA-pinned
  action; Stryker is a dev dependency like the rest of the Node side.
- **A pull request is measured on its own diff** (`--in-diff`): the
  mutants in the code it changed, and nothing else.
- **The whole workspace runs on a schedule**, weekly and on demand,
  under a 30-minute cap. `--shard` is the lever when that stops fitting.
- **The jobs report, they do not gate.** Neither is among the checks
  required to merge; they join that list once they have been green on
  their own for a while.
- **Generated code is mutated too.** A mutant that survives in
  `crates/protocol/src/generated.rs` is a hole in the golden vectors,
  and it is closed by a vector or a test, never by editing the generated
  file.
- **A mutant no test can kill is excluded in `.cargo/mutants.toml`,
  each with the reason it cannot be killed.** Three today: `main`'s exit
  code, OR against XOR in the version word, and reading a command that
  has no fields. Untested is not unkillable — that belongs in a test.
- **TypeScript runs on Stryker's command runner**, configured in
  `stryker.conf.mjs` and run whole on every pull request: fifteen
  seconds is not worth scoping to a diff. The vitest runner comes back
  when its Vitest 5 fix lands, and brings the per-test filtering the
  command runner gives up with it.
- **The TypeScript gate is a score rather than a list.** Stryker ignores
  a single mutant only through a comment in the source, and a generated
  file is not edited by hand, so the six there that no test can kill are
  held under a break threshold of 94 instead.

## Consequences

- A pull request that adds code no test would notice is told so, in the
  code it changed, before review.
- The weekly run is where the cost sits, and it grows with the engine.
  The cap is the alarm; sharding and scoping are the answers.
- The exclusion list has to be kept honest: every line claims that no
  test could kill that mutant, and one of them is about generated code,
  so it goes the day `stop` carries a field.
- A flaky test stops being one test's problem. `cargo mutants` needs a
  green baseline and reruns the suite once per mutant, so flakiness
  becomes noise across the whole run.
- `main` and the argv dispatch stay uncovered by design: reaching them
  means running the binary, which CI does on every pull request.
- The command runner reruns the whole Vitest suite for every mutant. At
  twelve tests that is free; it stops being free when the browser-mode
  tests of [ADR-0014](0014-tooling-and-ci.md) land, which is the point
  at which the vitest runner has to be working.

## Alternatives considered

- **A full run on every pull request.** Minutes now, and the engine is
  not written yet; the same signal arrives from the diff for a fraction
  of the cost.
- **A required check from day one.** It needs the exclusion list to be
  complete before the tool has run on anything but the generator, and an
  equivalent mutant would then block a pull request for something nobody
  can fix.
- **A line in CONTRIBUTING and nothing else.** Nothing would run it when
  it mattered: both rounds of findings came from runs that habit would
  not have produced.
- **Line coverage instead.** Coverage says a line ran. The `play` vector
  ran, and could not fail — which is the gap mutation testing exists to
  measure.
