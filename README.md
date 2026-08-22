# daw

A digital audio workstation that runs in the browser. Every sample is computed by a single Rust engine, compiled to WebAssembly and run inside one `AudioWorkletProcessor`. Web Audio's own nodes are used for nothing except the final connection to the speakers.

## Why it is built this way

The tempting shape — some audio in Rust, the rest in Web Audio nodes — is the expensive mistake here. It leaves two worlds with different notions of time (integer samples against `AudioParam` in seconds), different parameter interpolation and different node lifetimes, and every new feature has to stitch them together again.

One engine avoids that, and three things arrive with it for free:

- **Export is the same code**, called in a loop without a sound card, rather than a second rendering path that drifts from the first.
- **The output is deterministic**, so a render can be compared against a stored one, bit for bit, and every DSP module added later stays covered by that test.
- **Scheduling is sample-accurate by construction.** Events fire inside the render loop on the frame they belong to, so there is no look-ahead scheduler to get wrong.

The page and the audio thread talk through lock-free ring buffers in a `SharedArrayBuffer` — commands one way, transport position and levels the other, no `postMessage` on either. Nothing allocates on the audio thread; every buffer it touches is allocated once at start-up and never moves.

## State

Two milestones are closed. The first was a metronome computed in Rust and nothing beyond it: the transport, the command protocol, the ring buffer in both directions, the WASM build and the worklet. The second closed on 2026-08-21 and is a drum machine — sixteen steps across eight tracks, a sampler over a kit synthesised for it, a mixer with a gain and a pan per track above a soft-limited bus, and a page that plays the thing: an editable grid, a playhead drawn from the engine's own reading of where in the pattern it is, transport, and meters. Next is the project format — saving, opening, and undo.

Test counts are deliberately not quoted here. They were, and a milestone later they were wrong; `cargo test` and `pnpm test` are the current number.

Two gaps come with all of that, and both are recorded rather than closed. Nothing here detects an audio dropout: `currentTime` advances with the render thread rather than with the device, so the obvious detector compares that thread against itself, and Chrome has no `AudioRenderCapacity` yet. And samples are decoded by the browser, which resamples them to the device's rate — so one file is not quite the same audio on a 44.1 kHz machine as on a 48 kHz one. A WAV decoder written in Rust is what closes that, and it arrives with the offline export that needs it anyway.

## Building it

Requires a Rust toolchain, Node, and pnpm — not npm; the lockfile is pnpm's.

```sh
rustup target add wasm32-unknown-unknown

./scripts/build-wasm.sh          # release WASM  → web/public/engine.wasm
./scripts/build-worklet.sh       # esbuild bundle → web/public/worklet/processor.js

cd web
pnpm install
pnpm dev
```

Both build artifacts are gitignored and reproduced in full by their scripts. Neither sits in Vite's module graph, so the dev server takes care of them itself: it rebuilds the worklet bundle on every relevant edit and reloads the page, and it tells you when the compiled engine has fallen behind its Rust sources. That second one it only reports — a release build with link-time optimisation is not something to run on every keystroke, so `./scripts/build-wasm.sh` after a Rust edit stays yours to run.

Tests: `cargo test` from the root for the engine, `pnpm test` from `web/` for the TypeScript half.

## A note on hosting

`SharedArrayBuffer` requires cross-origin isolation, which means the two headers

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

on every response. The dev server and `pnpm preview` both set them. Any host has to be able to as well — without them the application does not degrade, it does not start.

## License

Proprietary. All rights reserved — see [LICENSE](LICENSE).

The repository is public so the code can be read. That grants no permission to use, copy, modify or distribute it, and none should be inferred from its being public.

Pull requests are not accepted: with no license granted, the rights to a contribution would be undefined.
