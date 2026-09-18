# ADR-0011. The engine boundary: one schema, two languages

- Status: accepted
- Date: 2026-09-17

## Context

The engine stays in Rust while the document, the network layer and the interface are written in TypeScript ([ADR-0002](0002-engine-rust-wasm-audioworklet.md), [ADR-0003](0003-crdt-yjs.md)). That means the boundary between them exists in two languages.

**Let us say the cost of that split out loud:** roughly 1100 lines of real logic — the shared-memory format (~586) and the musical time model (~502) — plus the tests that hold the two implementations in agreement. No compiler will check the two sides against each other. This is a standing cost, not a one-off.

A divergence here does not show up as an exception. It shows up as a click in the audio or an export that drifts out of sync — the least convenient place to debug.

## Decision

One source of truth that everything else is generated from, plus a shared set of checks that both sides run. Then a divergence shows up as a red test.

### 1. What the schema describes

- **The shared-memory layout** (the command ring, the state block, the audio descriptor): field names, types, offsets, enum values, which fields are atomic and in what order. This is a memory layout, not "messages on the wire": fixed offsets, byte order, atomic operations.
- **Musical time constants**: tick resolution, bounds, units.
- **The plugin contract** ([ADR-0008](0008-plugins.md)): how an event is written into a flat array, the parameter descriptor, the state block header, error codes, the ABI version. Same nature — fixed offsets and flat arrays, because the call happens in the audio thread and must not allocate. The trait in Rust and the interface in TS are written by hand; the data types come from the schema.

Time arithmetic (position → sample count, a tempo map with ramps) is not described by the schema: that is an algorithm. Only constants flow into it from the schema, and test vectors keep the computations in agreement.

### 2. Code generation

From the schema the generator emits:

- **for Rust** — structs and constants; the engine keeps using its own crates and the generator targets them;
- **for TS** — typed wrappers over `DataView`: offsets, enum values, field reads and writes.

The point is that nobody writes offsets and enum codes by hand in TS. A field added to the schema appears on both sides, and drift becomes a build error rather than a glitch in the audio.

### 3. What generates it

The layout is shaped by atomic operations and real-time constraints, so **a small generator of our own from a declarative schema** (TOML or JSON → Rust + TS) will most likely fit better than an off-the-shelf format: FlatBuffers and Cap'n Proto bring their own layout and their own story about atomicity, which may not sit well with our constraints.

An off-the-shelf format stays the fallback if our own generator turns out to cost more than it looks.

### 4. Checks that tie the two implementations together

- **Golden layout vectors.** A language-neutral file: "these field values ↔ these bytes". Both sides decode the bytes and must arrive at the same values; both encode the values and must produce byte-for-byte identical output. The file lives in the repository and both Rust and TS run it.
- **Musical time vectors.** A file: "(position, tempo map) → sample count". Both sides must agree. This catches divergences like `floor` versus a cast — exactly the class that makes an export drift away from playback.
- **Differential fuzzing.** One side generates random values, runs them through both implementations round-trip and checks equality. It catches what the vectors did not anticipate.

## Consequences

- TS types are generated rather than written by hand.
- A new field either appears on both sides or turns the build red.
- Agreement between the computations, not just the layouts, is verified by tooling rather than by eye.
- We take on a generator of our own to maintain.
- The vectors and the differential fuzzing have to run in CI on both sides, or the whole plan rests on good intentions.

## Alternatives considered

- **Writing both sides by hand.** Offsets and enum codes drift apart silently, and it surfaces as a click in the audio.
- **An off-the-shelf serialization format** (FlatBuffers, Cap'n Proto). Their own layout and their own assumptions about atomicity, which may not fit real-time requirements. Kept as the fallback.
- **Keeping the entire upper half in Rust**, so that there is no two-language boundary at all. Rejected per [ADR-0003](0003-crdt-yjs.md): the Rust CRDT libraries turned out to be fragile in wasm, and the TS interface ecosystem is more mature.
