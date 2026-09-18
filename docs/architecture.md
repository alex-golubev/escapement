# escapement architecture

> Status as of 2026-09-17: design stage, no code yet.
> Every decision is written up in detail in the [ADRs](adr/README.md).

## What we are building

A browser DAW with real-time collaborative editing.

- This is a real product, not a pet project.
- A pattern-based workflow: channel rack, patterns, playlist, mixer, with playlist tracks that are not tied to instruments ([ADR-0006](adr/0006-project-model.md)).
- A room holds 2–5 people.
- Chromium is the only supported browser at launch.
- Plugins are required. At first only the team writes them, in Rust and in TS/JS.
- AI assistance for musicians will come later. The architecture leaves room for it from day one.

## The whole picture

```
Browser (Chromium)
┌───────────────────────────────────────────────────────────────┐
│ Main thread                                                   │
│   Svelte 5 — thin rendering layer                             │
│     ↕ Atom ↔ runes adapter                                    │
│   Effect: state atoms + services                              │
│     Operations · Document · Collab · Engine · Transport ·     │
│     Selection · Undo · Assets · Api                           │
│      │                          │                             │
│      │ Yjs (+ IndexedDB)        │ commands ▼  ▲ meters, pos.  │
│      │                          │       (ring buffers, SAB)   │
│      │                 AudioWorklet: Rust engine (WASM)       │
│      │                 + plugins (WASM instances, TS)         │
│   Workers: decoding, time-stretch, editor scripts             │
└──────┼────────────────────────────────────────────────────────┘
       │ wss (Hocuspocus)               │ https (HttpApi)
┌──────▼────────────────────────────────▼───────────────────────┐
│ Server: Node + Effect                                         │
│   Collab (Hocuspocus core) · Http API · Auth · Projects ·     │
│   Assets · Jobs (export, AI tasks later)                      │
│   Native engine build for rendering                           │
└──────┬─────────────────────────┬──────────────────────────────┘
       │                         │
   Postgres                   S3 / R2
   metadata, permissions,     samples, renders, plugins
   Yjs state,                 (keyed by SHA-256)
   version snapshots
```

## Core principles

1. **The project document is the source of truth.** The engine knows nothing about CRDTs and can be rebuilt from the document at any moment. See [ADR-0001](adr/0001-document-source-of-truth.md).
2. **Every edit goes through a domain operation.** The UI, scripts and AI all use the same set of operations. See [ADR-0007](adr/0007-domain-operations.md).
3. **A panic in WASM must not kill the app.** The document layer has no Rust→WASM dependencies. The engine does not panic, and if it does go down it recovers. See [ADR-0002](adr/0002-engine-rust-wasm-audioworklet.md) and [ADR-0003](adr/0003-crdt-yjs.md).
4. **Real time is kept apart from everything else.** No allocations, no locks and no Effect in the audio thread.
5. **One schema describes the engine boundary.** Splitting the system into a Rust engine and a TypeScript upper half means the shared-memory format and the musical time model exist in two languages (roughly 1100 lines), and no compiler will check them against each other. So the boundary code is generated from a single schema, and golden vectors plus differential fuzzing keep the two sides in agreement. See [ADR-0011](adr/0011-engine-boundary-schema.md).
6. **Binary data lives outside the CRDT.** Samples, renders and plugin modules are stored by hash; the document holds only a reference. See [ADR-0009](adr/0009-assets-and-offline.md).

## Components

### Client

- **Svelte 5** is responsible for markup, windows and panels only. User events turn into action calls.
- **Effect** holds all logic and state: atoms (`effect/unstable/reactivity`) and services as layers:
  - `Operations` — domain operations on the document;
  - `Document` — the Yjs document, projections into atoms;
  - `Collab` — `HocuspocusProvider`, presence;
  - `Engine` — the bridge to the AudioWorklet: commands, SAB, crash recovery; it and the ring below it live in `packages/engine-host` ([ADR-0019](adr/0019-typescript-engine-host.md));
  - `Transport` — play/stop, position, tempo;
  - `Selection`, `Undo`, `Assets`, `Api` (`HttpApiClient` from `packages/api`).
- **Editors** (piano roll, playlist, waveforms, meters) are drawn on canvas (WebGL/WebGPU). The frame function is plain TS with no Effect.
- **Workers** run decoding, time-stretch and editor scripts.

Details in [ADR-0005](adr/0005-ts-stack-effect-svelte.md).

### Audio engine

- Rust → WASM, running in an AudioWorklet.
- The `engine-core` crate is platform-independent. Two hosts sit on top of it: `engine-wasm` for the browser and `engine-native` for tests and server-side rendering.
- It talks to the UI through lock-free ring buffers over SharedArrayBuffer.
- Only our own code runs in the AudioWorklet. Third-party crates run in separate workers.

Details in [ADR-0002](adr/0002-engine-rust-wasm-audioworklet.md).

### Server

- Node + Effect.
- The Hocuspocus core is embedded in the `Collab` layer. A single `http.Server` serves both plain HTTP and WebSocket.
- Services: `Http` (HttpApi), `Collab`, `Auth`, `Projects` (sql-pg), `Assets` (presigned URLs for S3/R2), `Jobs` (export, AI tasks later).
- The native engine build renders projects from a snapshot.

Details in [ADR-0004](adr/0004-sync-hocuspocus-in-effect.md).

### Storage

| Where | What |
|---|---|
| Postgres | users, projects, permissions, Yjs state (binary), version snapshots |
| S3 / R2 | samples, renders, plugin modules — keyed by SHA-256 |
| IndexedDB (client) | local copy of the document, unsent edits |
| OPFS (client) | asset cache |

## Main flows

### Editing a project

1. A user (or a script, or AI) triggers an action.
2. A domain operation is called: the input is validated against a Schema, then permissions are checked.
3. The operation runs as a single Yjs transaction carrying an origin and an author.
4. Yjs persists the edit to IndexedDB and sends it to the server, which fans it out to the other collaborators.
5. The `Engine` service sees the change (`observeDeep`) and translates it into engine commands. Local and remote edits take exactly the same path.
6. Atoms update, Svelte re-renders the DOM, and canvas editors redraw off a version counter.

### Playback

- Playback is local to each collaborator.
- The render is fully determined by the document plus asset and plugin versions. Random seeds are stored in the document.
- The UI reads playback position and meter levels from the SAB every frame.
- "Listen together" is a separate feature: transport synchronised against the server clock.
- Live jamming with tight timing over the network is out of scope.

### Engine crash

1. A trap in `process()` surfaces as a `WebAssembly.RuntimeError`.
2. The worklet outputs silence and reports to the main thread.
3. The main thread recreates the AudioWorkletNode with a fresh instance.
4. The new engine loads its state from the document.

The user hears a brief dropout, but the app keeps working.

### Assets

1. The client computes the file's SHA-256.
2. The HTTP API issues a presigned URL and the file is uploaded to S3/R2.
3. The hash is written into the document.
4. Other collaborators fetch the file by hash, cache it in OPFS and decode it in a worker.

## Product requirements from day one

- Authentication and roles: owner, editor, viewer.
- Observability: OpenTelemetry through Effect, engine crash reports.
- Backups and storage quotas.
- Surviving network drops (offline level 2, see [ADR-0009](adr/0009-assets-and-offline.md)).

## Repository layout (planned)

```
crates/
  engine-core     platform-independent engine core
  dsp             DSP blocks
  engine-wasm     AudioWorklet host
  engine-native   native host: tests, server-side rendering
  plugin-sdk      plugin contract for Rust + WASM export macro
  protocol        generated boundary code for Rust (Apache-2.0, ADR-0016)
schema/           declarative schema of the engine ↔ TS boundary (generation source)
packages/
  protocol        generated boundary code: shared-memory layout and types
  engine-host     ring, worklet glue, Engine service (ADR-0019)
  document        Schema for project entities, domain operations
  api             HttpApi definition, shared by server and client
  plugin-sdk      plugin contract for TS
  ui              Svelte components, Atom ↔ runes adapter, canvas editors
apps/
  web             client (Vite + Svelte)
  server          server (Node + Effect)
docs/
  architecture.md this document
  adr/            architecture decisions
```

Cargo workspace + pnpm workspaces.

## Stack and versions as of 2026-09-18

| What | Version | Note |
|---|---|---|
| Effect | 4.0.0-rc.115 | stable is 3.22.2, see ADR-0005 |
| Svelte | 5.57 | |
| Yjs | 13.6.x | 14 is in beta, Hocuspocus requires `^13.6.8` |
| Hocuspocus | 4.7 | |
| AssemblyScript | 0.28.20 | only a candidate for future third-party plugins |

Toolchain, pinned by [ADR-0014](adr/0014-tooling-and-ci.md):

| What | Version | Note |
|---|---|---|
| Rust | 1.98.1 stable | nightly only for the multi-threaded mixer, later |
| Node | 24 LTS | |
| pnpm | 12.4.2 | |
| TypeScript | 6.0.3 | 7.x dropped the compiler API that `svelte2tsx` needs |
| Vite | 8.3 | COOP/COEP headers in dev and preview |
| Vitest | 5.0 | browser mode on Playwright Chromium for SAB and the worklet |
| Biome | 2.5 | lint and format, Svelte support is experimental |

## License and repository

The repository is public. The core is AGPL-3.0-only with a plugin exception; the SDK and the boundary schema are Apache-2.0; documentation is CC BY 4.0. Outside contributions are accepted under a CLA. Infrastructure, security and business material live in a separate private repository. Details and boundaries in [ADR-0012](adr/0012-license-and-public-repo.md).

## Roadmap

0. **Skeleton.** Engine in an AudioWorklet, ring buffers, one synth, play/stop.
1. **Editors, no network.** Channel rack, step sequencer, piano roll, playlist, mixer. The document is already on Yjs and every edit goes through a domain operation. The first editor scripts in TS land here too.
2. **Multiplayer.** Server, authentication, presence, sample uploads.
3. **Beyond.** Automation, export, recording, more instruments and effects. Note effects in TS, then audio plugins in TS and WASM modules.

Later: third-party plugins and sandboxing, AI features, full offline (PWA).

## Open questions

- **Guarding against hung plugins:** time measurement or fuel metering.
- **Third-party plugins:** a sandbox for TS (AssemblyScript?), signing, moderation, WAM 2.0 support.
- **AI:** provider and models, consent rules for sending music out, including in shared projects.
- **Content licensing**, if a shared sample library appears.
- **Voice chat** (peer-to-peer WebRTC) — whether we want it.
- **Multi-threaded rendering** (wasm threads) — when and how.
