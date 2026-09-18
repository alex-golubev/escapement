# ADR-0004. Sync: the Hocuspocus core inside the Effect server

- Status: accepted
- Date: 2026-09-17

## Context

Yjs merges edits but does not move them across the network. We need a server: rooms, authentication, persistence, awareness. The server is written in TS + Effect ([ADR-0005](0005-ts-stack-effect-svelte.md)). A room holds 2–5 people.

## Decision

### Library

- **Hocuspocus 4.x** — an open-source library (MIT, TypeScript) from the Tiptap team:
  - `@hocuspocus/server` on the server;
  - `@hocuspocus/provider` on the client.
- Room = document = project id.

### Embedding it in Effect

- We use the `Hocuspocus` core, not the `Server` wrapper. Its `handleConnection(ws, request)` accepts any object with `send` / `close` / `readyState` plus a standard `Request`, so the core is not tied to a particular HTTP server.
- The `Collab` layer creates the instance. Hooks call Effect services through an Effect→Promise bridge carrying their context:
  - `onAuthenticate` — validates the token and project permissions, including read-only access;
  - `onLoadDocument` / `onStoreDocument` — load and persist through the `Projects` service (Postgres). We do not use the Database extension.
- The layer's finalizer persists open documents and closes connections, so graceful shutdown falls out for free.

### Transport

- A single Node `http.Server`:
  - ordinary requests are handled by the Effect HTTP server;
  - an `upgrade` on `/collab` goes to crossws and from there into `hocuspocus.handleConnection`. Their own `Server` wrapper works the same way.
- Later we can write an adapter from the Effect WebSocket socket to the Hocuspocus interface and keep everything inside Effect.

### Server-side access to a document

- Server scripts and AI connect to a document through `openDirectConnection`, without a WebSocket ([ADR-0007](0007-domain-operations.md)).

### Scaling

- A room lives on a single instance.
- Once there are several instances, everyone in a project is routed to the same one (sticky routing by project id).
- The Redis extension gets added only when we actually need it.

### Presence and collaboration

- Show everything: avatars, coloured cursors, who has which window open, a "follow a collaborator" mode.
- "Listen together" is a separate feature: transport synchronised against the server clock.
- Live jamming with tight timing over the network is out of scope: latency makes it impossible.
- Voice chat (peer-to-peer WebRTC) — possibly later.

## Consequences

- We do not write the sync protocol or awareness ourselves.
- Open documents live in the process's memory. Once projects get large and rooms numerous, that needs watching. When the last collaborator leaves a room, the document is unloaded.
- The Hocuspocus API is Promise-based, so a bridge into Effect is required.
- `HocuspocusProvider` has its own message format on top of y-protocols. Replacing the server means replacing the provider too.

## Alternatives considered

- **y-websocket.** A minimal reference server: authentication, persistence and scaling would all be ours to write.
- **Our own server on `y-protocols`.** Essentially a reimplementation of Hocuspocus.
- **Hosted services** (Liveblocks, PartyKit on Cloudflare Durable Objects). Less to operate, but a vendor dependency.
- **Y-Sweet.** Its server is built on yrs, ruled out by [ADR-0003](0003-crdt-yjs.md).
