# ADR-0003. CRDT: Yjs

- Status: accepted
- Date: 2026-09-17

## Context

Collaborative editing needs a CRDT. We looked at Yjs (pure JS), Loro (Rust → WASM), yrs (the Rust port of Yjs) and Automerge (Rust → WASM).

The choice was made from measurements, not impressions. The same technique was applied to all three: build a document shaped like our project, corrupt the bytes, feed the result back into the parser.

| Library | Language | Outcome on bad input | Process crashes |
|---|---|---|---|
| **Yjs 13.6** | JavaScript | a catchable exception (`try/catch`) | **0** across 1.2M cases |
| **Yrs 0.27.4** | Rust | a panic; in the browser, a dead page | 6 distinct sites, none in our code |
| **Loro 1.16** | Rust | process abort (SIGABRT) even on 64-bit | ~155 across 50k cases, 16 sites |

Details:

- **Yjs:** 4 runs of 300k cases, 0 crashes and 0 hangs. The bytes that took down Yrs produce ordinary `RangeError` or `Unexpected end of array`, with no gigabyte allocations.
- **Yrs:** on 32-bit (the same `usize` width as wasm32) a length overflow shows up on its own, without searching for it. Some of the problems are fixed in main, but unreleased.
- **Loro:** the panic poisons an internal lock, the destructor panics a second time, and `catch_unwind` does not save you.

The conclusion: the fragility is a property of two specific Rust CRDT implementations (panicking instead of returning an error) combined with wasm, where a panic takes down the whole instance. It is not a property of CRDTs as an idea, and not a verdict on Rust in general — it does not touch the engine ([ADR-0002](0002-engine-rust-wasm-audioworklet.md)). A JavaScript implementation closes the class by construction: there is no unsafe memory, and the exception is catchable.

## Decision

- Use **Yjs** (pure JS), version 13.6.x, on both client and server. Version 14 is still in beta.
- **The rule:** the collaborative editing layer has no dependencies on Rust compiled to WASM. The document is the source of truth ([ADR-0001](0001-document-source-of-truth.md)), so it has to be the most reliable part of the system.
- The local copy of the document and any unsent edits are kept in IndexedDB (`y-indexeddb`). A tab crash does not cost the user their work.
- **The document is isolated from the page.** With Yjs an exception no longer kills the app, but the isolation stays useful: it gives us a clean state to recover from.

### Document model (sketch)

```
doc
├─ channels      Y.Map<id, Y.Map>     name, type, params, mixer insert, order
├─ patterns      Y.Map<id, Y.Map>
│   └─ notes     Y.Map<noteId, JSON>  channel, position, length, pitch, velocity…
├─ arrangements  Y.Map<id, Y.Map>
│   ├─ tracks    Y.Map<id, Y.Map>     order, name, height
│   └─ clips     Y.Map<id, JSON>      track, position, length, ref to pattern/audio/automation
├─ mixer         Y.Map<id, Y.Map>     inserts, effect slots, routing
└─ automation    Y.Map<id, Y.Map>
```

The entities are described in [ADR-0006](0006-project-model-fl.md).

### Storage principles

- **Notes, clips and automation points are stored as whole JSON values.** Keeping every note in its own `Y.Map` turns 10k notes into tens of thousands of internal Yjs objects. The price: when the same note is edited concurrently, one version wins wholesale. For notes that is acceptable. The decision needs confirming with a prototype.
- **Channels, parameters and the mixer are stored as nested `Y.Map`s.** Conflicts resolve per field: one collaborator turns the cutoff while another renames the channel.
- **Ordering is an `order` field** with fractional indexing, ties broken by id. We do not use `Y.Array` for ordered entities: it has no move operation.
- **Version history is periodic server-side snapshots** (`encodeStateAsUpdate`). Rolling back to a version is applied as a new edit. We do not use Yjs's built-in snapshots: they require `gc: false`, and the document then grows without bound.
- **Undo** is `Y.UndoManager` with `trackedOrigins`, so only your own edits are undone. `captureTimeout` collapses a single gesture into one step.
- **Ephemeral data** (cursors, selections, intermediate values during a gesture) goes over awareness. Only the final value is written to the document.
- **Validation on read.** Data coming out of the document is validated against a Schema (`packages/document`). Invalid entities are skipped and take down neither the client, nor the server, nor the engine.
- **The server must validate an update before writing it.** This is not optional: one bad update, once persisted, breaks the project for everyone, permanently. On the server (64-bit) bad bytes are caught normally — the panic problem was browser-only.

## Consequences

- A whole class of failures (a CRDT panic inside WASM) is ruled out.
- Yjs is well tested and comes with a ready server ([ADR-0004](0004-sync-hocuspocus-in-effect.md)), awareness, UndoManager and IndexedDB persistence.
- With no move in arrays, ordering has to be maintained through fractional indices.
- There is no rewindable history; versions are server-side snapshots.
- A malicious client can write anything into the document, so every reader has to validate the data.

## Alternatives considered

- **Loro.** Rejected over the WASM panic. It had upsides: MovableList, Tree, built-in version history.
- **yrs.** Rejected for the same reason. Which also rules out Y-Sweet: its server is built on yrs.
- **Automerge.** Its core is Rust in WASM as well — the same class of risk.

The decision can be revisited if the bug is fixed upstream, but there is no need: Yjs covers what we need.
