# ADR-0010. Chromium only at launch

- Status: accepted
- Date: 2026-09-17

## Context

A browser DAW depends on what the platform offers: SharedArrayBuffer, AudioWorklet, Web MIDI, WebGPU, file access. Supporting every browser at once stretches the test matrix and slows development down. Safari, for one, has no Web MIDI, and its AudioWorklet has quirks of its own.

## Decision

- **The target browser at launch is Chromium** (Chrome, Edge and other Chromium-based browsers).
- Firefox is the next candidate. Safari comes later.
- The site is served cross-origin isolated (COOP `same-origin` + COEP), which is required for SharedArrayBuffer ([ADR-0002](0002-engine-rust-wasm-audioworklet.md)). We account for the consequences from day one:
  - some OAuth popups break, so sign-in has to be designed around it;
  - third-party embeds need CORP/COEP headers or the `credentialless` attribute on the iframe.
- **We use what Chromium offers:**
  - Web MIDI;
  - WebGPU — for drawing the editors and, later, for small models;
  - OPFS — the asset cache ([ADR-0009](0009-assets-and-offline.md));
  - File System Access API — attaching a sample folder from disk;
  - multiple windows: the mixer on a second monitor through `window.open` (same-origin windows are compatible with COOP) and Document Picture-in-Picture for floating panels.
- **Known limitation:** the browser reports input and output latency imprecisely, so recording from a microphone will need calibration.

## Consequences

- A smaller test matrix and faster development.
- Part of the audience (Safari) is out of reach at launch.
- Platform features are kept behind services so browsers can be added later without reworking the core.

## Alternatives considered

- **All major browsers from the start.** More expensive, and some of the APIs we need (Web MIDI in Safari) are unavailable anyway.
