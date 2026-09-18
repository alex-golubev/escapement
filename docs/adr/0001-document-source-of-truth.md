# ADR-0001. The project document is the source of truth

- Status: accepted
- Date: 2026-09-17

## Context

Several sources edit a project at once: the people in the room, scripts, and later AI. The audio engine, meanwhile, needs a different shape of the same data: flat, pre-allocated, usable under real-time constraints.

If the engine owned the state, an engine crash would mean data loss, and sync would have to run through the audio thread.

## Decision

- The single source of truth about a project is the Yjs document on the TS side ([ADR-0003](0003-crdt-yjs.md)).
- The engine knows nothing about CRDTs. The `Engine` service subscribes to document changes (`observeDeep`) and translates them into engine commands. Local and remote edits take exactly the same path.
- The engine keeps its own model for rendering. It can be rebuilt from the document from scratch at any moment.
- Native rendering on the server receives a plain project snapshot (JSON per the Schema in `packages/document`), not a CRDT.

## Consequences

- An engine crash costs no data: the engine is recreated and loads its state from the document ([ADR-0002](0002-engine-rust-wasm-audioworklet.md)).
- The engine can be tested without a CRDT and without a browser.
- Sync, undo, history and offline all live in one layer.
- We need a translation layer from document changes to engine commands, and it has to be kept in agreement with the model.
- Loading a whole project into the engine has to be fast: it happens when a project is opened and after a crash.

## Alternatives considered

- **The engine owns the state, the UI only displays it.** An engine crash would mean data loss, and the CRDT would have to live in Rust/WASM. That path is closed for the reasons in [ADR-0003](0003-crdt-yjs.md).
