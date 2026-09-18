# ADR-0016. The generated Rust lives on the Apache side

- Status: accepted
- Date: 2026-09-18

## Context

[ADR-0012](0012-license-and-public-repo.md) drew the licensing boundary
before the boundary code existed as files. It puts `schema/`,
`crates/plugin-sdk`, `packages/plugin-sdk` and `packages/protocol` under
Apache-2.0, and everything else under AGPL, so that a plugin author
never has to think about our license.

[ADR-0013](0013-boundary-code-generation.md) then made the generator
emit two outputs from that schema: TypeScript and Rust.
`packages/protocol` is named on the Apache side. Its Rust counterpart
is not named anywhere, because at the time it was not a separate thing.

Left alone, the generated Rust would land inside `engine-core`, which is
AGPL. Two consequences follow, and neither is acceptable:

- `crates/plugin-sdk` is Apache-2.0 and needs those types —
  [ADR-0011](0011-engine-boundary-schema.md) says the plugin contract's
  data types come from the schema. It would have to depend on an AGPL
  crate.
- A plugin author writing in Rust could not take the types of a
  boundary we publish as Apache without pulling in AGPL code, while the
  author of the same plugin in TypeScript could. The asymmetry has no
  justification: it is the same schema and the same bytes.

## Decision

The generated Rust lives in **`crates/protocol`**, licensed
**Apache-2.0**, mirroring `packages/protocol` on the TypeScript side.
`engine-core` and `crates/plugin-sdk` both depend on it.

`crates/protocol` holds generated code and nothing else. No hand-written
logic goes in, so nothing of the engine reaches the permissive part of
the repository by the back door. The rule is easy to check, because the
crate's contents are reproduced by `cargo xtask generate` and CI already
fails on any difference
([ADR-0013](0013-boundary-code-generation.md)).

[NOTICE](../../NOTICE) is updated to name the crate. Every file keeps
its SPDX line, which governs where the file and the notice disagree.

## Consequences

- The boundary is Apache-2.0 in both languages, which is what
  [ADR-0012](0012-license-and-public-repo.md) intended and what makes
  the plugin exception mean the same thing for both.
- One more crate in the workspace, containing no decisions.
- A rule to hold: hand-written code does not go into `crates/protocol`.
  The generator's diff check enforces it as a side effect.

## Alternatives considered

- **Generate into `engine-core`.** The licensing inversion above: an
  Apache SDK depending on AGPL types, and Rust plugin authors treated
  differently from TypeScript ones for no reason.
- **Write the types by hand a second time in `crates/plugin-sdk`.** Two
  descriptions of one boundary, which is the failure
  [ADR-0011](0011-engine-boundary-schema.md) exists to prevent.
- **Move `crates/plugin-sdk` to AGPL.** It would make the boundary
  consistent by giving up the point of having a plugin SDK.
