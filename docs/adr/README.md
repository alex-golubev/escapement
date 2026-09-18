# Architecture Decision Records

This is where the project's architecture decisions are recorded: what we decided, why, and what follows from it. The whole picture is in [architecture.md](../architecture.md).

## How we keep these

- One decision per file, `NNNN-short-name.md`, following the [template](template.md).
- Statuses: `proposed`, `accepted`, `rejected`, `superseded by ADR-NNNN`.
- An accepted ADR is not rewritten in substance. If a decision changes, we write a new ADR and mark the old one as superseded.

## Index

| № | Decision | Status |
|---|---|---|
| [0001](0001-document-source-of-truth.md) | The project document is the source of truth | accepted |
| [0002](0002-engine-rust-wasm-audioworklet.md) | Audio engine: Rust → WASM in an AudioWorklet | accepted |
| [0003](0003-crdt-yjs.md) | CRDT: Yjs | accepted |
| [0004](0004-sync-hocuspocus-in-effect.md) | Sync: the Hocuspocus core inside the Effect server | accepted |
| [0005](0005-ts-stack-effect-svelte.md) | TS stack: Effect everywhere, Svelte 5 as a thin layer | accepted |
| [0006](0006-project-model.md) | Project model and workflow | accepted |
| [0007](0007-domain-operations.md) | Every project edit goes through a domain operation | accepted |
| [0008](0008-plugins.md) | Plugins and extensions | accepted |
| [0009](0009-assets-and-offline.md) | Content-addressed assets and offline support | accepted |
| [0010](0010-chromium-only.md) | Chromium only at launch | accepted |
| [0011](0011-engine-boundary-schema.md) | The engine boundary: one schema, two languages | accepted |
| [0012](0012-license-and-public-repo.md) | License and the contents of the public repository | accepted |
| [0013](0013-boundary-code-generation.md) | Generating the boundary code | accepted |
| [0014](0014-tooling-and-ci.md) | Development tooling and CI | accepted |
