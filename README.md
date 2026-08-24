# Escapement

A browser DAW with a Rust core. Sample-based production, real-time collaborative
editing, modelled on FL Studio.

Architectural decisions and the reasoning behind them live in
**[ARCHITECTURE.md](ARCHITECTURE.md)**.

> An *escapement* is the mechanism in a clock that releases the gear train in
> steps. Fitting for a DAW: it is exactly about turning continuous time into
> discrete beats.

## Status

Early development. There is no working application yet.

## Layout

| Crate | Purpose |
|---|---|
| `crates/core` | Audio core: graph, nodes, mixer, DSP. **Real-time safe, no allocation** |
| `crates/model` | Project model: entities, musical time, CRDT document |
| `crates/worklet` | wasm module for `AudioWorklet` |
| `crates/render` | Canvas renderer for the playlist and piano roll. **Framework-agnostic** |
| `crates/app` | Leptos client |

The sync service (relay, asset storage, accounts) lives in a **separate private
repository** and is not part of this one.

## Building

```sh
rustup target add wasm32-unknown-unknown
cargo install trunk

trunk serve      # development, http://localhost:8080
cargo test       # tests
cargo clippy --workspace --all-targets
```

The dev server must send `COOP`/`COEP` headers, otherwise there is no
`SharedArrayBuffer`. This is configured in `Trunk.toml`; production hosting must
send the same headers.

## License and rights

**The code is open, the rights belong to the author.**

There is deliberately no `LICENSE` file yet, which by default means all rights
are reserved. The decision is postponed and blocks nothing (ARCHITECTURE.md §5.1).

Two rules already apply:

1. **Permissively licensed dependencies only.** Never GPL: shipping a wasm bundle
   to the browser is distribution of the program, so a GPL dependency would force
   the entire product to be released under the GPL.
2. **Contributions require a signed CLA.** See [CONTRIBUTING.md](CONTRIBUTING.md).
