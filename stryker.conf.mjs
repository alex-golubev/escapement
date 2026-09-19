// SPDX-License-Identifier: AGPL-3.0-only
//
// Mutation testing for the TypeScript half of the boundary (ADR-0021).
//
// The command runner rather than the vitest runner: under Vitest 5 the
// runner's per-test filter matches no test, so every mutant is reported as
// surviving (stryker-js#6210, open). The command runner switches a mutant on
// through the environment and runs the suite whole, which at this size costs
// seconds.

export default {
  testRunner: "command",
  commandRunner: { command: "pnpm test" },
  mutate: ["packages/*/src/**/*.ts"],
  reporters: ["clear-text", "progress"],
  // Six mutants of the generated file cannot be killed by any test: `slot +
  // offset` where the offset is zero, and the byte-order flag on a write of
  // zero. Stryker ignores a mutant only through a comment in the source, and a
  // generated file is not edited by hand, so the gate here is a score and not
  // a list of exceptions.
  thresholds: { high: 100, low: 95, break: 94 },
}
