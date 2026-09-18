# ADR-0005. TS stack: Effect everywhere, Svelte 5 as a thin layer

- Status: accepted
- Date: 2026-09-17

## Context

The UI and the server are written in TypeScript. The app is complex: a lot of state, a lot of asynchrony, resources with a lifecycle (the AudioWorklet, connections, workers). The interface is dense, and the editors have to render without lag.

## Decision

### Effect

- Effect is used on the server and on the client alike.
- **Version: v4** (as of 2026-09-17 that is 4.0.0-rc.115; stable is 3.22.2). The project is new and production is far off, so migrating from v3 to v4 later would cost more than the small fixes we will make before the final release.
- In v4, HTTP, HttpApi, RPC, SQL, AI and reactivity live in `effect/unstable/*`. `@effect/platform-node` and `@effect/sql-pg` remain separate packages.
- Shared packages:
  - `packages/api` — the HttpApi definition. The client gets a typed `HttpApiClient` with no code generation.
  - `packages/document` — the Schema for project entities and the domain operations ([ADR-0007](0007-domain-operations.md)).
- Observability is OpenTelemetry through Effect.

### Server

- The runtime is Node. Hocuspocus over crossws works on Bun too, but Effect + pg + Node is the most predictable combination.
- Services:
  - `Http` — HttpApi: accounts, projects, assets, jobs;
  - `Collab` — the Hocuspocus core ([ADR-0004](0004-sync-hocuspocus-in-effect.md));
  - `Auth` — sessions, tokens, project permissions;
  - `Projects` — a repository on sql-pg: Yjs state, version snapshots;
  - `Assets` — presigned URLs for S3/R2;
  - `Jobs` — a job queue: export, and AI tasks later (Effect workflow/cluster).

### Client

- **Svelte 5** is responsible for markup, windows and panels, and for passing user actions along. Logic and state live in Effect.
- **State** is `Atom` and `AtomRegistry` from `effect/unstable/reactivity`:
  - services are assembled in `Atom.runtime(AppLayer)`;
  - actions are described with `Atom.fn`, and components call them rather than running effects themselves;
  - keyed collections use `Atom.family`.
- One `AtomRegistry` per app, passed through Svelte context.
- **The Svelte binding is ours to write.** Official ones exist only for React, Solid and Vue. The foundation is `createSubscriber` from `svelte/reactivity`, with `@effect/atom-solid` (about 400 lines) as the reference:

  ```ts
  import { createSubscriber } from "svelte/reactivity"

  export const fromAtom = <A>(registry: AtomRegistry, atom: Atom<A>) => {
    const subscribe = createSubscriber((update) => registry.subscribe(atom, update))
    return {
      get current() {
        subscribe()
        return registry.get(atom)
      },
    }
  }
  ```

  On top of that we need writes into atoms and a wrapper over `AsyncResult` (loading, error, value).
- **Editors** (piano roll, playlist, waveforms, meters) are drawn on canvas (WebGL/WebGPU). Svelte only provides the shell: panels, file browser, dialogs.
- **The window system is ours**: floating windows inside the workspace, and in Chromium also windows on a second monitor ([ADR-0010](0010-chromium-only.md)).
- **Build: Vite + Svelte, no SvelteKit.** A DAW does not need SSR, we have our own server, and COOP/COEP headers are easier to control without a second one. There are few screens (sign-in, project list, editor), so a lightweight router is enough.

### Where we do not use Effect

- **Inside the AudioWorklet.** A garbage collector and allocations in the audio thread are unacceptable.
- **In the frame function** of canvas editors and meters. Effect manages only the render loop's lifecycle (starting it in a fiber and stopping it when the scope closes).
- **For individual notes.** There is no atom per note. `Atom.family` keyed by `patternId` returns the note collection with a version counter, and the canvas redraws as a whole. Individual atoms are only needed where Svelte renders DOM: channels, mixer, pattern list.

## Consequences

- The API definition and the entity schemas are shared by client and server.
- Resources with a lifecycle (worklet, connections, workers) are managed through layers and scopes.
- The `unstable` modules may change before the final v4 release. The fixes will mostly land in the Atom ↔ Svelte adapter.
- The Svelte binding is ours to maintain.
- Effect has a steeper learning curve for new developers than plain TS.

## Alternatives considered

- **Effect v3.** Stable, but migrating to v4 later costs more.
- **React.** Bigger ecosystem, easier hiring, and an official Atom binding. We chose Svelte as the thinner layer.
- **Solid.** Signals suit large numbers of small updates well, and there is an official Atom binding. We chose Svelte.
- **SvelteKit.** Its server-side features duplicate our own server, and we do not need SSR.
