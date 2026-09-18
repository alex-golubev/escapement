# Workflows

`ci.yml` runs on every pull request and on pushes to `main`.

Jobs are added alongside the code they guard, never afterwards
(ADR-0014):

- `rust` — formatting, clippy, tests, including the golden vectors.
- `boundary` — the generated code still matches `schema/`, and no atomics
  reached the engine.
- `ts` — Biome, types, and the golden vectors from the other side.

Still to come, each with the change that needs it: `browser`
(Playwright) with `apps/web`, `fuzz` with the command decoder, and
`licenses` with the SPDX check.
