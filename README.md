# Escapement

A browser DAW with a Rust core. Sample-based production, real-time collaborative
editing, modelled on FL Studio.

Architectural decisions and the reasoning behind them live in
**[ARCHITECTURE.md](ARCHITECTURE.md)**.

> An *escapement* is the mechanism in a clock that releases the gear train in
> steps. Fitting for a DAW: it is exactly about turning continuous time into
> discrete beats.

## Status

Early development. There is no application yet — the first vertical slice
(ARCHITECTURE.md §7) is under way. A Rust graph renders quanta inside an
`AudioWorklet`, out of a wasm module whose linear memory is shared with the page
and carries the command ring and the state block, which is what closed the
question of whether that combination works at all.

It makes no sound yet, and that is the design rather than a fault: the engine
has a transport, and a transport that has not been started has not been started
— the interface says when. Reaching the ring from the page is the next step.
Everything below it — clips, the mixer, the model — is still to be written.

## Layout

| Crate | Purpose |
|---|---|
| `crates/core` | Audio core: graph, nodes, mixer, DSP. **Real-time safe, no allocation** |
| `crates/model` | Project model: entities, musical time, CRDT document |
| `crates/protocol` | What the two wasm modules say to each other through shared memory. **`no_std`, compiled into both** |
| `crates/view` | The same region reached from outside it, through `Atomics`. **The half that needs JavaScript, kept where the worklet cannot link it** |
| `crates/worklet` | wasm module for `AudioWorklet` |
| `crates/render` | Canvas renderer for the playlist and piano roll. **Framework-agnostic** |
| `crates/app` | Leptos client |

The sync service (relay, asset storage, accounts) lives in a **separate private
repository** and is not part of this one.

## Building

The toolchain — a pinned nightly, the wasm target and the `rust-src` component
that `build-std` needs — comes from `rust-toolchain.toml`. `rustup show` installs
all of it; nothing has to be added by hand.

```sh
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all --check

cargo build --workspace --target wasm32-unknown-unknown --release
python3 tools/check-shared-memory.py target/wasm32-unknown-unknown/release/*.wasm
```

That last check is not ceremony: `+atomics` alone links a *private* memory, and
the build still succeeds. It fails in the browser, with an error that points at
the wasm rather than at the missing linker flag.

To run the current slice:

```sh
tools/build-first-sound.sh              # worklet + dist-first-sound/
tools/dev-server.py dist-first-sound    # http://127.0.0.1:8080
```

The page reports the handshake — cross-origin isolation, the render quantum, and
where the shared region sits — and stays silent, for the reason under *Status*.

`Trunk.toml` is configured but Trunk is deliberately out of the loop until the
audio path is settled — a build tool in the chain is a second suspect when
something breaks. That is also why the probe assembles `dist-first-sound/` of
its own: `dist` is Trunk's, and Trunk clears it on every build. Install Trunk
with **`cargo +stable install trunk`**: run inside the repository, plain
`cargo install` picks up the pinned nightly, and trunk's `lightningcss`
dependency does not compile there.

Either server must send `COOP`/`COEP` headers, otherwise there is no
`SharedArrayBuffer` and the failure looks like broken wasm rather than a missing
header. Configured in `Trunk.toml` and in `tools/dev-server.py`; production
hosting must send the same.

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
