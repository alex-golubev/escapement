# ADR-0012. License and the contents of the public repository

- Status: accepted
- Date: 2026-09-18

## Context

escapement is being built as a product, but the repository will be public. That raises three separate questions, and it matters not to conflate them: what protects the core from a closed competing hosted service, on what terms we accept outside contributions, and what must never physically end up in the public repository.

Facts that bear on the choice:

- The product has a server side ([ADR-0004](0004-sync-hocuspocus-in-effect.md)), so "take the code and run your own hosting" is a real scenario.
- The product lives on an ecosystem of extensions ([ADR-0008](0008-plugins.md)). A plugin author must not have to think about licensing, or there will be no plugins.
- The dependencies of the upper half (Effect, Svelte, Yjs, Hocuspocus) are MIT and do not constrain our choice. Rust dependency licenses get checked as we add them: `symphonia`, for example, is MPL-2.0, which is compatible but obliges us to publish changes to the MPL files themselves.
- There is no legal entity yet; the rights holder is an individual.

## Decision

### Licenses by part of the repository

| Part | License |
|---|---|
| `apps/web`, `apps/server`, `crates/engine-core`, `crates/engine-wasm`, `crates/engine-native`, `crates/dsp`, `packages/document`, `packages/ui`, `packages/api` | AGPL-3.0-only + a plugin exception |
| `schema/`, `crates/plugin-sdk`, `packages/plugin-sdk`, `packages/protocol`, plugin examples | Apache-2.0 |
| `docs/`, ADRs included | CC BY 4.0 |
| Samples, presets, fonts | per file; only CC0, CC-BY or our own in the public repository |

We take `AGPL-3.0-only`, not `-or-later`: the terms of future versions of the license are unknown to us.

Mechanics: a `LICENSE` file in every package, an `SPDX-License-Identifier` line in the header of every source file, and the `license` field filled in `package.json` and `Cargo.toml`. The root `LICENSE` is AGPL-3.0 and the root `README` carries the table above.

### The plugin exception

We add an additional permission under AGPL §7: a module that interacts with the host only through the published plugin ABI and SDK is not a derivative work of the host. The text lives in `LICENSE-PLUGIN-EXCEPTION` and is referenced from the headers of the host files that make up the plugin boundary.

The point: a third-party plugin can be closed source and under any license, while a fork of the host itself stays under copyleft.

### Outside contributions

- A CLA, checked on pull requests through cla-assistant. Without it, AGPL locks us in too: selling a commercial exception or re-releasing the code under another license would be impossible.
- The CLA text must include a clause on transferring rights to a future legal entity — the rights holder is an individual today, and that has to survive incorporation.
- `CONTRIBUTING.md` explains why the CLA exists and states plainly that contributions to `schema/` and the SDK are made under Apache-2.0.

### The name

The license grants no rights to the name or the logo. `TRADEMARK.md`: a fork may not call itself escapement or use our logo.

### What is public

All of the code, `schema/` with its golden vectors ([ADR-0011](0011-engine-boundary-schema.md)), `docs/architecture.md` and the ADRs, the plugin SDK and examples, benchmarks and load test results, `CONTRIBUTING.md`, `SECURITY.md` (the intake channel only — GitHub private vulnerability reporting), `LICENSE*`, `NOTICE`, `TRADEMARK.md`.

### What is private

A separate private repository, `escapement-ops`:

- infrastructure as code, environment configuration, domains;
- private vulnerability analysis and postmortems;
- moderation and abuse handling rules;
- room limits and antifraud rules — publishing them would amount to instructions for getting around them;
- prompts and policies for the future AI layer;
- product and monetisation strategy, pricing, a roadmap with dates;
- content agreements.

Secrets live in git in neither repository: only in a secret manager, with references in the repository. CI on the public repository runs secret scanning so a stray commit cannot make it into history.

## Consequences

- A closed competing hosted service is impossible without publishing its changes; self-hosting by users is allowed and welcome.
- Full OSI status: the project can be packaged, it can be described as open, and contributors and plugin authors are not put off.
- The CLA preserves the option of a commercial exception and, if needed, of releasing future versions under a stricter license. The reverse move — from a closed license to an open one — does not work, which is why we start open.
- The price of the CLA is that some casual contributors will not sign it. We consider that acceptable.
- We take on a standing obligation: track dependency licenses and keep `NOTICE` current. CI needs license checking (`cargo-deny` and an npm equivalent).
- The public/private boundary takes discipline when committing. A separate repository was chosen precisely for that: infrastructure cannot be committed to the public repository by accident.

## Alternatives considered

- **FSL-1.1-Apache-2.0.** Stronger protection: an outright ban on competing use, with every release becoming Apache-2.0 after two years. But it is not open source, and for a tool that lives on an ecosystem of extensions, the loss of trust costs more than the extra protection. It stays an option for later — the CLA does not close it off.
- **BSL 1.1.** Maximum protection (non-production use free, a change date up to four years) with minimum friendliness. Excessive for our stage.
- **Apache-2.0 or MIT for everything.** Best for the ecosystem and zero protection for a product with a server side: an invitation to clone the hosting without investing in the development.
- **Closed source, with only the SDK and documentation public.** It cuts off both the community and self-hosting, and the protection against a clone is incomplete anyway. It also contradicts the wish to run the project in the open.
