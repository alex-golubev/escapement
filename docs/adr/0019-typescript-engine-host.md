# ADR-0019. The TypeScript half of the boundary lives in `packages/engine-host`

- Status: accepted
- Date: 2026-09-18
- Amends the licensing table of [ADR-0012](0012-license-and-public-repo.md)

## Context

[ADR-0013](0013-boundary-code-generation.md) put the atomics on the JavaScript side and moved the ring container out of the schema: the engine never sees it, so it is a TypeScript concern alone. It did not say where that TypeScript lives, and neither does anything else. The planned layout in [architecture.md](../architecture.md) names `packages/protocol`, `document`, `api`, `plugin-sdk` and `ui`, and `apps/web` as the Vite client; [ADR-0005](0005-ts-stack-effect-svelte.md) names only `api` and `document` as shared packages and leaves the client services unplaced.

A fair amount of code needs that home, and none of it is UI: the command ring over `SharedArrayBuffer`, the worklet processor and the glue that drains the ring into the staging area and publishes meters back, module instantiation with the ABI check ([ADR-0015](0015-command-records-and-engine-abi.md)), crash recovery ([ADR-0002](0002-engine-rust-wasm-audioworklet.md)), and the `Engine` service ([ADR-0005](0005-ts-stack-effect-svelte.md)).

The first answer we reached for was the licensing boundary, since that is what gave `crates/protocol` a crate of its own ([ADR-0016](0016-generated-rust-is-apache.md)). It does not decide this: a license says Apache or AGPL, not package or no package. This code is AGPL wherever it goes.

## Decision

**`packages/engine-host`**, AGPL-3.0-only, holds the whole TypeScript half of the engine boundary except the generated `packages/protocol`: the ring, the worklet processor and its glue, module loading and the ABI check, crash recovery, and the `Engine` service.

It is named a host, not an engine: `engine-core` is the engine, and the package sits beside `engine-wasm` and `engine-native` as the third host, the one written in TypeScript.

**Effect lives in the package and stops at the worklet.** The `Engine` service is the cold half — layers, scopes, the worklet's lifecycle, crash recovery, atoms for the UI — and it is Effect like the rest of the client. Below it nothing is: draining the ring, copying into staging and publishing meters are free functions over views, because they run inside `process()` where [ADR-0002](0002-engine-rust-wasm-audioworklet.md) permits no allocation and [ADR-0018](0018-functional-by-default.md) already fixed the shape.

The licensing table of [ADR-0012](0012-license-and-public-repo.md) gains `packages/engine-host` on the AGPL side, and [NOTICE](../../NOTICE) names it. The dependency runs one way: `engine-host` uses `packages/protocol`, never the reverse.

`apps/web` keeps what is genuinely the application's: the Vite configuration with its COOP/COEP headers, the worklet module URL, and assembling `AppLayer`.

## Consequences

- `packages/ui` can read meter levels and playback position without depending on the application, which is what the canvas editors do every frame.
- The Chromium browser tests that [ADR-0014](0014-tooling-and-ci.md) requires for `SharedArrayBuffer` and the worklet become a Vitest project of their own, with their own cross-origin headers, rather than running through the application's bundle.
- A desktop shell, which [ADR-0002](0002-engine-rust-wasm-audioworklet.md) already anticipates as the reason `engine-native` exists, reuses the host instead of copying it out of the web client.
- One more package to carry: a `LICENSE`, a `package.json`, a line in the layout.
- A rule with nothing mechanical behind it: no Effect and no allocation below the service, inside `process()`. The atomics grep of [ADR-0013](0013-boundary-code-generation.md) has no equivalent here, so for now this rests on review.

## Alternatives considered

- **`apps/web/src/engine/`.** Costs no package, and the licensing does not forbid it. Rejected because `packages/ui` needs the meter reads: the dependency would run from a package into the application, and the browser tests would reach the ring through the application's bundle.
- **Split it: the ring in a package, the glue and the service in the application.** One subsystem in two homes, with no rule to say which half a new file belongs to.
- **`packages/protocol`.** Apache-2.0 and generated only ([ADR-0016](0016-generated-rust-is-apache.md)). Hand-written glue there would put engine code into the permissive part of the repository by the back door.
- **The name `packages/engine`.** Next to `crates/engine-core` it reads as the engine, which it is not.
