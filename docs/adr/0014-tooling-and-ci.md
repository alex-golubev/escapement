# ADR-0014. Development tooling and CI

- Status: accepted
- Date: 2026-09-18

## Context

The design stage is over and the skeleton is next. Several decisions
already taken are only as real as the machinery that enforces them:

- no allocations, no locks and no panics in the audio path
  ([ADR-0002](0002-engine-rust-wasm-audioworklet.md));
- no atomics anywhere in `engine-core` or `engine-wasm`
  ([ADR-0013](0013-boundary-code-generation.md));
- generated boundary code is committed and must still match the schema
  ([ADR-0013](0013-boundary-code-generation.md));
- nothing writes into Yjs outside `packages/document`
  ([ADR-0007](0007-domain-operations.md));
- SharedArrayBuffer requires cross-origin isolation
  ([ADR-0002](0002-engine-rust-wasm-audioworklet.md),
  [ADR-0010](0010-chromium-only.md));
- parts of the repository are Apache-2.0 rather than AGPL
  ([ADR-0012](0012-license-and-public-repo.md)).

Every one of those is a rule a person can forget on a Friday. This ADR
decides what remembers them instead.

Two facts about the ecosystem on 2026-09-18 constrain the choices:

- `typescript@7.0.2`, the native compiler, holds the `latest` tag, and
  its package no longer exports the compiler API: the root export is
  `./lib/version.cjs`, the rest is `./unstable/*`, and there is no
  `tsserver` binary. Everything that embeds the compiler has to be
  rewritten against the new API or stay on 6.x.
- `@effect/vitest` targets Effect 3 (peers `effect ^3.22.0`,
  `vitest ^3.2.0`). Effect 4 ships its own `effect/testing` export, so
  the package is not needed and not used.

## Decision

### Workspaces and pinned versions

A Cargo workspace and pnpm workspaces share one repository root, over
the layout in [architecture.md](../architecture.md).

Everything that can be pinned is pinned to an exact version, because a
toolchain that drifts turns a green build on one machine into a red one
on another for reasons unrelated to the change:

| What | Pin | Where |
|---|---|---|
| Rust | 1.98.1 stable | `rust-toolchain.toml`, with `rustfmt`, `clippy`, target `wasm32-unknown-unknown` |
| Node | 24 LTS | `.nvmrc` and `engines` |
| pnpm | 12.4.2 | `packageManager`, through corepack |
| TypeScript | 6.0.3 | not 7.x, see below |

Rust stays on stable from day one, which is what
[ADR-0013](0013-boundary-code-generation.md) bought by moving the
atomics to JavaScript. Nightly stays scoped to the multi-threaded mixer.

**TypeScript is pinned to 6.0.3, one major behind `latest`, and there
is exactly one copy of it in the workspace.** The native 7.x compiler
is faster and we want it, but `svelte2tsx` reads the compiler API out
of the `typescript` package, and 7.x no longer puts it there.

`svelte-check` 4.7.6 does offer a way through, behind
`--tsgo` / `--tsgo-experimental-api`, with both compilers installed
side by side (`typescript@~6` for the API, `@typescript/native` for the
checker). Its documented limitation is what rules it out here: a Svelte
file outside the root directory of its `tsconfig.json` is not properly
loaded or type-checked. Our components live in `packages/ui` and are
consumed by `apps/web`, so that describes our layout exactly, and a
check that silently skips the shared components is worse than a slow
one.

Say the cost of the pin out loud: 6.0.3 was released on 2026-04-16 and
is the last version of the JavaScript-based compiler. The 6.x line has
had no patch since, and 7.0.2 took the `latest` tag in July. We are
pinned to a compiler that is mature and no longer maintained.

We move to 7.x when the `svelte-check` tsgo path stops being
experimental and covers Svelte files across workspace packages. Not
before, and not partially: a workspace with two compilers in it would
have to explain which diagnostics came from which.

Lockfiles are committed, as `.gitignore` already says.

### The wasm build carries no bindgen

`cargo build --target wasm32-unknown-unknown --release`, crate type
`cdylib`, plain exported functions over the engine's own memory,
`wasm-opt` from binaryen in release builds.

**`wasm-bindgen` and `wasm-pack` are not used.** The glue on the
JavaScript side is generated from `schema/`
([ADR-0013](0013-boundary-code-generation.md)) or written by hand for
the ring container, and it runs inside an AudioWorklet. A bindgen
wrapper would add a second, competing description of the same boundary
and put its own glue on the hot path — the exact thing
[ADR-0011](0011-engine-boundary-schema.md) exists to prevent.

Build flags: `-C target-feature=+simd128`
([ADR-0002](0002-engine-rust-wasm-audioworklet.md)), and never
`+atomics` ([ADR-0013](0013-boundary-code-generation.md)).

### Rust checks

- `rustfmt` with the default profile.
- `clippy` with `-D warnings`. In `engine-core` and `dsp` the lints
  `unwrap_used`, `expect_used`, `indexing_slicing` and `panic` are
  errors, declared once in `[workspace.lints.clippy]`.
- `assert_no_alloc` in debug builds guards `process()`.

### TypeScript and Svelte: Biome

**Biome 2 both lints and formats; Prettier and ESLint are not used.**
One binary, one config, no plugin matrix to keep in sync.

Svelte support is experimental and has to be switched on explicitly:
`html.experimentalFullSupportEnabled` together with
`html.formatter.enabled`. Cross-language rules can still produce false
positives inside `.svelte` files; we silence individual rules through
`overrides` when they do, and we accept that this area of Biome moves.

Two things Biome does not do, which are covered separately:

- **Types.** `svelte-check` runs over the components, `tsc --noEmit`
  over the packages.
- **The module boundary.** `noRestrictedImports` denies `yjs` and
  `y-*` outside `packages/document`, and `@hocuspocus/*` outside the
  `Collab` layer, which is how
  [ADR-0007](0007-domain-operations.md) stops being a promise.

### Tests

- **Rust:** `cargo test` against the native host, which is what
  `engine-native` was built for
  ([ADR-0002](0002-engine-rust-wasm-audioworklet.md)).
- **TypeScript:** Vitest 5. Node environment for the document layer,
  the operations and the server.
- **Browser:** Vitest browser mode on Playwright, Chromium only
  ([ADR-0010](0010-chromium-only.md)), for everything that needs a real
  `crossOriginIsolated` page: SharedArrayBuffer, the ring buffers, the
  AudioWorklet, crash recovery.
- **Golden vectors** are one language-neutral file read by both
  `cargo test` and Vitest, written by hand
  ([ADR-0013](0013-boundary-code-generation.md)).
- **Fuzzing:** `cargo-fuzz` on the command decoder, plus a differential
  round-trip between the two implementations.

### CI: GitHub Actions

Jobs, each of which fails the build:

- **rust** — `fmt --check`, `clippy -D warnings`, `cargo test`, and the
  wasm32 build.
- **boundary** — `cargo xtask generate` followed by
  `git diff --exit-code`; the golden vectors on both sides; and a grep
  over `crates/engine-core` and `crates/engine-wasm` for
  `core::sync::atomic`. The grep is not paranoia: such code compiles,
  runs, looks correct and synchronises nothing
  ([ADR-0013](0013-boundary-code-generation.md)).
- **ts** — `biome ci`, `svelte-check`, `tsc --noEmit`, Vitest in Node,
  Vitest in Chromium.
- **fuzz** — a short `cargo-fuzz` run on pull requests; long runs are
  scheduled.
- **licenses** — `cargo-deny` for dependency licenses, and a check that
  `schema/`, `crates/plugin-sdk`, `packages/plugin-sdk` and
  `packages/protocol` carry Apache-2.0 headers rather than AGPL ones
  ([ADR-0012](0012-license-and-public-repo.md)).

Third-party actions are pinned by commit SHA, not by tag.

### The dev server is cross-origin isolated

Vite serves `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` in both `server.headers`
and `preview.headers`. The client asserts `crossOriginIsolated` at
startup and refuses to start without it, so a missing header is a clear
error at boot rather than a mysterious absence of sound
([ADR-0010](0010-chromium-only.md)).

### No git hooks

Checks run in CI. The same commands are available locally as pnpm
scripts and `cargo xtask` tasks, and nobody's commit waits on a
formatter.

### The CLA check is manual for now

[CONTRIBUTING.md](../../CONTRIBUTING.md) promises a bot, and as of
2026-09-18 no maintained general-purpose one exists:
`contributor-assistant/github-action` was archived in March 2026, and
`cla-assistant/cla-assistant` last saw a substantive commit in October
2023 with 248 issues open. EasyCLA needs Linux Foundation membership,
and a DCO app answers a different question — it does not grant the
rights [ADR-0012](0012-license-and-public-repo.md) depends on.

So: a required status check that a maintainer flips by applying a
`cla-signed` label, with acceptances recorded in the private
repository. There are no outside contributors yet, so this costs
nothing today. If that changes, we write the small action ourselves
rather than adopt an abandoned one.

## Consequences

- Every rule from an earlier ADR that could be forgotten now fails a
  build instead.
- We sit one major behind on TypeScript, deliberately, and carry the
  obligation to revisit it.
- Biome's Svelte support is experimental, so some churn in
  `biome.json` is expected. We take that over four packages of ESLint
  and Prettier plugins.
- No wasm-bindgen means no ready-made JS bindings: everything crossing
  the boundary goes through `schema/`, which is the point.
- Browser-mode tests need Playwright's Chromium in CI, which is the
  slowest job we are signing up for.
- CI is the only gate, so a broken local commit is normal and a broken
  `main` is not.

## Alternatives considered

- **ESLint 10 with Prettier.** The mature path for Svelte and the only
  one with type-aware rules. Rejected as four moving parts where one
  will do; the module boundary rule, which was the real reason to want
  ESLint, exists in Biome too.
- **oxlint.** Far faster, but no Svelte templates and no type-aware
  rules.
- **TypeScript 7 now**, through `svelte-check --tsgo` with both
  compilers installed. Rejected for the root-directory limitation
  above, not out of preference.
- **Two compilers**: 7.x for the packages that contain no Svelte,
  6.0.3 under `svelte-check` for the ones that do. Most of the code
  would typecheck on a maintained compiler. Rejected because one
  workspace would then have two type checkers that can disagree, and
  the answer to "which one reported this?" has to be free.
- **wasm-pack / wasm-bindgen.** A second description of the boundary
  and glue on the hot path.
- **`@effect/vitest`.** Effect 3 only; Effect 4 has `effect/testing`.
- **lefthook or husky.** A pre-commit hook that regenerates `schema/`
  would save the occasional red CI run, at the price of a delay on
  every commit forever.
- **Turborepo or Nx.** Nothing to orchestrate yet. Revisit when the
  build graph is slow enough to notice.
- **cla-assistant, contributor-assistant, EasyCLA.** Abandoned,
  archived, or tied to a foundation we are not part of.
