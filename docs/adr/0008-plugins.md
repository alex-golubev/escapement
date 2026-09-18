# ADR-0008. Plugins and extensions

- Status: accepted
- Date: 2026-09-17

## Context

- Plugins are required.
- At launch only the team writes them; there is no marketplace.
- It has to be possible to write plugins in Rust and in TS/JS.
- VST is unavailable in the browser, so we write the built-in instruments and effects ourselves too.
- Someone else's code in the audio thread is a risk: a panic in WASM breaks the instance ([ADR-0003](0003-crdt-yjs.md)), and a hang takes the audio down.

## Decision

### Three kinds of extension

| Kind | Where it runs | Examples | Languages |
|---|---|---|---|
| **Editor scripts** | a worker, not real time | piano roll tools, melody generators, batch edits, MIDI controller scripts | TS |
| **Note effects** | audio thread | arpeggiator, chord generator, randomiser | TS, Rust |
| **Audio plugins** | audio thread | synths, effects | Rust, TS (with discipline), C/C++, Faust |

### A single contract

- `crates/plugin-sdk` — Rust: a trait and a macro that builds a WASM module with our ABI.
- `packages/plugin-sdk` — TS: the plugin interface and memory wrappers.
- **The contract is described by the same declarative schema as the engine boundary** ([ADR-0011](0011-engine-boundary-schema.md)), and code for both sides is generated from it.
- What the contract covers:
  - the descriptor: parameters (id, range, default, flags), ports, latency;
  - `process(events, buffers)`, with events (notes, parameter changes) accurate to the sample within a block;
  - saving and loading state;
  - an input-silence signal, for smart disable.
- The schema generates the layouts and constants: how an event is written into a flat array, the parameter descriptor, the state block header, error codes, the ABI version. The trait in Rust and the interface in TS are written by hand, but all their data types come from the schema.
- The two sides are kept in agreement by the same checks as the engine boundary: golden vectors for the event layout and differential fuzzing.
- The engine compensates for plugin latency (PDC).
- The ABI is versioned from day one so we can open it up later without breakage. The version lives in the schema, and editing a field bumps it; the host refuses to load a module with an incompatible version.
- To the host, every plugin looks the same. How it is invoked is hidden behind an adapter.

### Execution models

**1. Built-in plugins (Rust).** They implement the same trait but are linked into the engine statically, with no overhead. This way we are our own API's first users and feel its rough edges quickly.

**2. WASM modules.**
- Each instance is a separate `WebAssembly.Instance` with its own memory. Buffers are copied between engine memory and plugin memory, so a plugin cannot corrupt the engine's memory.
- A plugin gets only the imports the host hands it: no network, no DOM, no files.
- A trap is caught at the call boundary. Only that instance is switched off (bypassed, with a notification); the engine keeps running.
- Languages: Rust (our SDK), C/C++ via clang/Emscripten, Faust.

**3. TS/JS in the AudioWorklet.**
- Runs next to the engine. Buffers are passed without copying: the plugin gets `Float32Array`s that view engine memory directly.
- The call is wrapped in `try/catch`. A JS exception is caught normally, the engine stays intact, and the plugin goes to bypass.
- No allocation is allowed in `process`. The SDK is built so that natural code does not allocate:
  - buffers and events arrive pre-allocated;
  - events live in a flat typed array rather than an array of objects;
  - in dev mode the host times every plugin and warns when one exceeds its budget.
- Effect is not used inside `process`.
- There is no isolation: the plugin shares one global context with the engine. Acceptable for our own plugins, not for third-party ones.

### Editor scripts

- They run in a worker.
- They receive the selection and context (scale, tempo) and return edits through domain operations ([ADR-0007](0007-domain-operations.md)).
- The host applies the edits in a single transaction: they sync to collaborators immediately and undo in one step.
- They never touch the audio thread, so anything goes inside them, Effect included.

### Collaboration

- In the document a plugin is stored as a reference to the hash of a specific version, just like an asset ([ADR-0009](0009-assets-and-offline.md)). Everyone hears the same thing.
- Parameters live in the document as individual fields, so conflicts resolve per field.
- The rest of a plugin's state is an opaque blob; on concurrent edits the last write wins.
- If a collaborator does not have the plugin, we show a placeholder and keep its data in the document.

### Plugin UI

1. At first, only an automatically generated UI from the declared parameters.
2. Later, a plugin's own UI in an isolated cross-origin iframe communicating over `postMessage`. Under COEP this needs either the `credentialless` iframe attribute or the right headers on the plugin's side.

### Order of work

1. Built-in instruments in Rust through the trait — alongside the first synth.
2. Editor scripts in TS — alongside the piano roll.
3. Note effects in TS, the arpeggiator first. They are where we shake down the real-time contract.
4. Audio plugins in TS and WASM modules.
5. Third-party plugins and sandboxing — a separate decision.

## Consequences

- One contract across every language and execution model, generated from the schema rather than written out twice by hand.
- When we do open plugins up, the SDK for third-party authors is the published schema plus the generator. Wrappers for a new language can be built without us.
- A panic or exception in a plugin switches off only that plugin.
- **Risk: a hung plugin.** WASM or JS running inside the worklet cannot be interrupted, so an infinite loop takes all audio down. Options (to pick later):
  - time every plugin and switch off the ones that miss their budget;
  - instrument the WASM module with an instruction counter (fuel metering) at load time.
- Every WASM instance has its own memory, and with dozens of instances that adds up.
- No plugins exist in our format, so we are creating the ecosystem ourselves.

## Open until plugins are opened to the community

- **A sandbox for TS plugins.**
  - AssemblyScript (0.28.20 as of 2026-09-17) is a TS subset that compiles to WASM. The project is alive but still 0.x, and it is not quite TS: a different memory model, language restrictions.
  - JS → WASM compilers (Porffor) are still alpha.
- Signing and moderation.
- WAM 2.0 support as a separate kind of external node, with caveats around routing.

## Alternatives considered

- **WAM 2.0 as the primary format.** Every plugin is a separate AudioWorkletNode running arbitrary JS. Our graph falls apart into pieces, and sidechain and sends across those boundaries get hard. Third-party JS runs in the engine's thread, where it can read shared memory or take the audio thread down.
