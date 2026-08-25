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

**The source is published; the rights are the author's.**

The code is under the [PolyForm Shield License 1.0.0](LICENSE). Read it, build
it, change it, use it for **any** purpose — including making music you sell,
and including using it in a studio — with one exception: you may not use it to
provide a product that competes with Escapement or with the service it connects
to.

The restriction is aimed at a fork-turned-competitor, not at musicians. Anything
you make *with* the DAW is yours, commercially or otherwise; the DAW itself is
not something to be resold or re-hosted.

This is deliberately **not** an open source licence in the OSI sense. The source
is public; the rights are not. Saying it plainly beats saying nothing: a public
repository with no licence at all means *all* rights reserved, which reads to
most people as the opposite of what it is.

Two rules follow:

1. **Permissively licensed dependencies only.** Never GPL: shipping a wasm bundle
   to the browser is distribution of the program, so a GPL dependency would force
   the entire product to be released under the GPL.
2. **Contributions require a signed CLA.** The contributor keeps copyright and
   grants the project a broad, irrevocable, sublicensable licence — that is what
   keeps relicensing possible later. See [CONTRIBUTING.md](CONTRIBUTING.md).
