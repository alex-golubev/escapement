# Escapement

[![CI](https://github.com/alex-golubev/escapement/actions/workflows/ci.yml/badge.svg)](https://github.com/alex-golubev/escapement/actions/workflows/ci.yml)
[![License: AGPL-3.0-only](https://img.shields.io/badge/license-AGPL--3.0--only-blue)](LICENSE)

A collaborative DAW in the browser — [escapement.run](https://escapement.run).

Early development — nothing usable yet.

## Roadmap

1. **One person, the whole loop** — now: tracks and clips, piano roll, synth and sampler, a mixer with effects,
   buses, sends and sidechain, a starter sound library, export to WAV.
2. **Together** — a server, projects shared live, who is doing what, undo of your own changes, sounds in the cloud.
3. **Audio** — audio clips and recording, automation clips, export to FLAC and MP3.
4. **Later** — plugins by others, an AI collaborator, live jams.

## Stack

- UI: TypeScript, Preact; Effect for orchestration
- Project model: Yjs, so several people can work on one project
- Audio engine: Rust compiled to WebAssembly, running in an AudioWorklet over shared memory

## How it works

- The page edits the project, a Yjs document (`packages/model`): every change, yours or a collaborator's, lands there.
- The compiler (`packages/compiler`) turns what changed into messages for the engine.
- Live changes — a knob, a key pressed, play and stop — go through a ring buffer in shared memory straight to the
  AudioWorklet, which runs the engine and makes the sound.
- Changes to what plays — instruments, effects, their connections, notes and clips — go to the build thread, a Worker
  on the same engine and memory: it builds them away from the audio thread and hands them over ready. The engine
  answers through shared memory too: meters, the playhead, refusals.

## Browsers

Escapement is tested in Chrome only; Firefox and Safari haven't been tried yet.

The engine's threads share memory, which a browser allows only on a cross-origin isolated page: every response,
the workers' scripts included, needs `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`. All but `reopen.html`: the app goes there when its audio thread hangs,
and without isolation it gets a fresh process. The dev server does this (`apps/web/vite.config.ts`); a server of your
own must too.

## Repository layout

| Path | What it is |
|---|---|
| `apps/web` | The web app |
| `apps/placeholder` | The page escapement.run shows until the app is out |
| `packages/model` | The project document on Yjs: how it is stored, read and edited, with undo |
| `packages/compiler` | Turns the project into what the engine plays, sending only what changed |
| `packages/engine` | Runs the engine in the browser: the build thread, the AudioWorklet and the shared memory between them |
| `packages/engine-description` | What the engine and the page agree on: time, notes, the plugin catalog and its parameters |
| `crates/engine-core` | The engine: DSP, sequencer, mixer graph |
| `crates/engine-plugins` | What a plugin sees, and the built-in plugins |
| `crates/engine-wasm` | The engine's WebAssembly exports |
| `crates/describe-plugins` | Prints the plugin catalog for code generation |
| `schema` | The FlatBuffers schema of what the page and the engine send each other |
| `tools` | Code generation, the debug samples and the mutation tests |
| `samples` | Debug drum sounds, synthesized by `tools`, CC0 |

## Development

Needs Node 26.12+, pnpm 12 and rustup; the Rust toolchain comes from `rust-toolchain.toml`.

```sh
pnpm install
pnpm dev        # the app on a local Vite server
pnpm test       # lint, types, unit tests in TypeScript and Rust
pnpm --filter @escapement/web exec playwright install chromium   # once, for the browser tests
pnpm test:e2e   # the app in a real browser
pnpm test:mutants   # mutation tests of the Rust this branch changes, committed or not
```

## Contributing

The design still changes a lot. Issues are welcome; before a pull request, open an issue to agree on the change. See
[CONTRIBUTING.md](CONTRIBUTING.md); report vulnerabilities as [SECURITY.md](SECURITY.md) says.

## License

[GNU Affero General Public License v3.0 only](LICENSE).
