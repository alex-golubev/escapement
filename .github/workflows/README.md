# Workflows

`ci.yml` runs on every pull request and on pushes to `main`.

Jobs are added alongside the code they guard, never afterwards
(ADR-0014):

- `rust` — formatting, clippy, tests.
- `ts` — Biome (format and lint in one pass).

Still to come, each with the change that needs it: `boundary`
(regeneration diff, golden vectors, the atomics grep) with `schema/`,
`browser` (Playwright) with `apps/web`, and `licenses` with the first
Apache-2.0 crate.
