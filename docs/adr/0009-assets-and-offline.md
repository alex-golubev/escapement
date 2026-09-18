# ADR-0009. Content-addressed assets and offline support

- Status: accepted
- Date: 2026-09-17

## Context

- Samples, renders and plugin modules are large binary files. Storing them in the CRDT would bloat the document and slow sync down.
- A user must not lose work when the network drops.
- Full offline (local-first) is wanted eventually.

## Decision

### Assets

- Samples, renders and plugin modules are stored in S3/R2 under their SHA-256 (content-addressed). The document holds only the hash.
- Upload:
  1. the client computes the file's hash;
  2. the HTTP API issues a presigned URL;
  3. the file is uploaded to storage;
  4. the hash is written into the document.
- Other collaborators fetch the file by hash, cache it in OPFS and decode it in a worker.
- In Chromium, the File System Access API lets a user attach a whole sample folder from disk without uploading anything ([ADR-0010](0010-chromium-only.md)).

### Offline levels

| Level | What it means | When |
|---|---|---|
| 1. Online only | the editor locks up without a network | not used |
| 2. Surviving drops | edits are saved locally (Yjs + IndexedDB) and sent on reconnect | day one |
| 3. Full offline | projects open and get created without a network, PWA, assets in OPFS | later |

- **Level 2** is nearly free with Yjs + Hocuspocus, and we need it regardless.
- **The architecture is already ready for level 3:** content-addressed samples in OPFS and the document in IndexedDB are needed for load speed anyway. What is left for the transition:
  - PWA and a service worker;
  - an asset cache that respects browser quotas;
  - signing in without a network;
  - handling the case where project access was revoked while the user was offline;
  - UX for reviewing changes after a long divergence. Yjs will merge everything automatically, but if two people spent a week rearranging an arrangement differently, the result may be meaningless.

### Server-side storage

- Postgres: users, projects, permissions, Yjs state as binary, version snapshots.
- S3/R2: assets.
- Backups and storage quotas from day one.

## Consequences

- The document stays light, and identical files are not duplicated.
- Reopening a project is fast: assets come from OPFS.
- We need garbage collection for assets no longer referenced by any document or snapshot.
- If a shared sample library appears, we will have to deal with content licensing.

## Alternatives considered

- **Binary data in the CRDT.** It bloats the document and the history.
- **Online-only mode.** Too fragile for a product: the network goes, the work stops.
- **Full offline right away.** Too expensive for launch, and the architecture does not block it.
