# ADR-0007. Every project edit goes through a domain operation

- Status: accepted
- Date: 2026-09-17

## Context

Projects are edited by the UI, by editor scripts, and in the future by an AI assistant and external agents. If each of them writes into Yjs directly, validation, permissions, undo and history have to be repeated in every one of those places.

An AI assistant needs a formal set of actions. The architecture for AI has to be laid down now, even though the AI features themselves come later.

## Decision

### The operations layer (from day one)

- `packages/document` holds a typed set of domain operations built on Effect Schema: `addNotes`, `moveClip`, `setParam`, `routeInsert` and so on.
- Writing into Yjs around this layer is not allowed. Access to the `Y.Doc` exists only inside `packages/document`.
- Running an operation:
  1. validate the input against a Schema;
  2. check permissions;
  3. a single Yjs transaction.
- The operation's name becomes the step name in undo and in history.

### Operations work on any document (from day one)

- An operation takes the document as a parameter instead of reaching for a global one.
- That gives us **suggestion mode**:
  1. changes are prepared on a copy of the document;
  2. the user listens to the result and looks at the diff;
  3. "Accept" applies the diff to the main document in a single transaction.
- Until the result is approved, collaborators do not see it.

### Authorship of edits (from day one)

- Every transaction carries an origin and an author: a person, a script or AI.
- History shows who did what.
- Edits from one author can be undone as a group.

### Extension points for AI (as we go)

- **A compact textual representation** of a project or a selection: notes, chords, structure, routing. This is context for a model, and also a tool for debugging, tests and export.
- **Offline rendering of part of a project** with metrics, so AI can "listen" to the result ([ADR-0002](0002-engine-rust-wasm-audioworklet.md)).
- **A shared `Jobs` queue** (Effect workflow/cluster) with progress on the client. It runs export, and later stem separation, audio-to-MIDI transcription and generation. Results are stored as content-addressed assets ([ADR-0009](0009-assets-and-offline.md)).

### AI as a collaborator in the room (future)

- The AI assistant is just another client of the document. On the server it connects through Hocuspocus's `openDirectConnection` ([ADR-0004](0004-sync-hocuspocus-in-effect.md)).
- Its edits reach everyone the same way a human collaborator's do. It has presence, and its edits are undoable.
- Domain operations map almost directly onto `Tool` / `Toolkit` from `effect/unstable/ai` (on the same schemas).
- The same set of operations can be exposed to external agents through `McpServer`.

### Possible AI features (not planned now)

- A chat assistant: "sidechain the bass off the kick", "why is this mix muddy?".
- Note generation: melodies, chords, drums — editor scripts with a model inside.
- Audio work: stem separation, audio to MIDI, sample generation. Heavy work on the server, light work in the browser on WebGPU.
- Neural effects: small models inside plugins ([ADR-0008](0008-plugins.md)).
- Semantic sample search through embeddings (`EmbeddingModel` in Effect AI).

### Deferred

- Choice of provider and models (Effect AI abstracts over providers).
- Vector databases.
- The AI features themselves.

**Before any AI feature ships** we need product rules:
- a user's music goes to an external provider only with explicit consent;
- whose consent is required in a shared project;
- user data is not used for training.

## Consequences

- Validation, permissions, undo and history work identically no matter where the edit came from.
- Wiring up AI and external agents reduces to describing tools over operations that already exist.
- There is an extra level of indirection: the operation set has to cover everything the UI needs.
- It takes discipline, plus module boundary checks, to keep anyone from writing into Yjs directly.

## Alternatives considered

- **Writing into Yjs directly from the UI and scripts.** Simpler at first, but validation, permissions and history spread through the code, and wiring up AI later gets hard.
