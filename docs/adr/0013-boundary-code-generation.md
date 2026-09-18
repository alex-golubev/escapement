# ADR-0013. Generating the boundary code

- Status: accepted, amended by [ADR-0018](0018-functional-by-default.md)
- Date: 2026-09-18

## Context

[ADR-0011](0011-engine-boundary-schema.md) settled that the engine
boundary is generated from a single schema and left open what does the
generating. This ADR answers that, and in doing so pins down how the two
sides reach each other's memory at all.

What has to be generated: the layout of fixed-size records (command
slots, the meter block, plugin event records, parameter descriptors),
enum and error codes, musical time constants, and the ABI version.

Two facts shape the answer.

**This is not serialization.** The same bytes are read and written from
two languages, at offsets known when the code is compiled, with no
encode step and no allocation on the hot path. Every off-the-shelf IDL
solves a different problem — moving data from one place to another.

**The dominant risk is a padding disagreement.** If the schema, or a
generator, computes a field's offset differently from rustc, both sides
compile and run, and the symptom is a click in the audio rather than an
exception. Any answer here has to make that impossible, not unlikely.

Threads matter too. Making the engine's own linear memory a
`SharedArrayBuffer` requires the module to declare shared memory, which
needs the `atomics` target feature, which needs `-Z build-std` and
therefore nightly Rust. [ADR-0002](0002-engine-rust-wasm-audioworklet.md)
already parks that cost with the multi-threaded mixer, and we would
rather not pay it earlier.

## Decision

### Atomics live in JavaScript; the engine stays on stable Rust

`process()` in an AudioWorklet is JavaScript, and the engine is called
from it. So the synchronisation sits on the JavaScript side of the call:

- **Commands.** The main thread writes into a ring in its own
  `SharedArrayBuffer` using `Atomics`. The worklet's glue drains the
  ring, copies the fixed-size records into a staging area inside the
  engine's ordinary, **unshared** wasm memory, and calls the export. The
  engine reads a plain array and touches no atomics.
- **Meters and position.** The engine writes plain values into its own
  memory. After `process()` returns, the glue publishes them into the
  shared buffer with `Atomics.store`, and the UI reads them every frame
  as planned.

The cost is a copy of tens to hundreds of bytes per 128-sample block.
That copy sits next to one the browser already forces on us: `process()`
hands over ordinary `Float32Array`s, so audio is copied into wasm memory
regardless. Nothing about the structure changes.

**There are no atomics anywhere in `engine-core` or `engine-wasm`**, and
CI greps for them rather than trusting anyone to remember.
`core::sync::atomic` is available on `wasm32` without the `atomics`
feature and LLVM lowers it to plain loads and stores, which is correct
for single-threaded code. Such code compiles, runs and looks right while
providing no synchronisation at all — the worst shape a bug can take.

### Offsets are explicit in the schema

Every field in the schema carries its own offset. The generator computes
no layout: it checks alignment and overlap and emits what is written.

The generated Rust then carries, per field and per record:

```rust
const _: () = assert!(core::mem::offset_of!(CommandSlot, kind) == 4);
const _: () = assert!(core::mem::size_of::<CommandSlot>() == 32);
```

So it no longer matters who computed what. If rustc disagrees with the
schema, the build is red before anything reaches the audio thread.

### What the schema covers, and what it does not

Covered: fixed-size record layouts, enum and error codes, musical time
constants, the ABI version.

Not covered:

- **The ring container** — head, tail, capacity, wraparound. With
  atomics on the JavaScript side, the engine never sees it, so it is a
  TypeScript concern alone. The shared surface is smaller than
  [ADR-0011](0011-engine-boundary-schema.md) assumed.
- **Time arithmetic.** An algorithm, not a layout. Constants come from
  the schema; agreement between the computations is held by test
  vectors.
- **Anything of variable length, and anything optional.** Records are
  fixed size. A large payload is referenced by an index into a
  pre-allocated arena, never inlined. A request for an optional field is
  the signal that we have drifted into serialization and should stop.

### What the generator emits

- **Rust:** `#[repr(C)]` structs, constants, and the static assertions
  above.
- **TypeScript:** a table of offset constants plus free functions,
  `writeSlotKind(view, base, value)`, for the hot path — monomorphic,
  allocation-free, and inlined by the engine that runs them. Class-style
  accessors are emitted as well for cold paths such as reading meters
  once a frame. (The class was withdrawn by
  [ADR-0018](0018-functional-by-default.md); the cold path returns a
  snapshot instead.)

Two details the generator exists to get right, because they are wrong
exactly once when written by hand:

- **Byte order.** `DataView.getInt32(offset)` is big-endian by default
  and wasm is little-endian. The generated code always passes the
  little-endian flag.
- **Atomic fields.** `DataView` has no atomic operations, so those
  fields are accessed through an `Int32Array` over the same buffer,
  where the index counts elements rather than bytes. The generator
  divides, and refuses to generate a field marked atomic that is not
  aligned to its width.

### The generator itself

A Rust `xtask` in the cargo workspace: TOML in, text out, a few hundred
lines, no code generation framework. The engine's CI needs cargo anyway,
and the TypeScript side never runs the generator because its output is
committed.

**Generated code is committed to the repository**, and CI regenerates it
and fails on any diff. The reason is not convenience: when a field
moves, that has to be visible in review, which is the whole point of
[ADR-0011](0011-engine-boundary-schema.md).

The ABI version is a hash of the normalised schema alongside a
human-set major number. Editing a field changes the hash, so the bump
that [ADR-0008](0008-plugins.md) relies on cannot be forgotten.

### Checks

- **Golden vectors are written by hand** as literal bytes. Vectors
  produced by the generator would only prove that the generator agrees
  with itself, while the test suite looked green.
- **Differential fuzzing** between Rust and TypeScript provides the
  coverage that hand-written vectors cannot.
- Both run in CI, on both sides.

## Consequences

- Stable Rust from day one. Nightly and `-Z build-std` stay scoped to
  the multi-threaded mixer, where [ADR-0002](0002-engine-rust-wasm-audioworklet.md)
  already put them.
- The surface shared between the two languages shrinks, so there is less
  that can drift.
- A moved field is a build error rather than a glitch in the audio.
- We maintain a generator. It is small and deliberately stupid: no
  layout algorithm, no optionality, no evolution rules.
- The engine cannot read directly out of a shared asset cache. A decoded
  sample is copied into engine memory once, on a path that is not real
  time, and the engine holds the only copy it plays from.
- The schema stays a language-neutral file, which is what
  [ADR-0012](0012-license-and-public-repo.md) licenses under Apache-2.0
  so that plugin authors can build against it without reading our Rust.

## Alternatives considered

- **Rust as the source of truth**, with `offset_of!` feeding a TypeScript
  emitter. It removes the padding risk just as well, and the layout is
  then whatever rustc says by construction. Rejected because the schema
  would stop being language-neutral: a third-party plugin author would
  have to read Rust to implement the ABI, and golden vectors would lose
  their independent source.
- **A generator that computes the layout** from field types. This is
  where the padding disagreement lives, and explicit offsets remove the
  risk at no cost.
- **FlatBuffers, Cap'n Proto.** Their fixed-layout structs would fit the
  memory model, unlike their tables. But the generated JavaScript wraps
  access in objects, neither has a story for atomics, and we would carry
  a whole toolchain to use a twentieth of it.
- **Protobuf, MessagePack, bincode, postcard.** Encoding and allocation
  on a path that permits neither.
- **rkyv.** Zero-copy between Rust and Rust; there is no TypeScript
  side.
- **WIT and the component model** (wit-bindgen, jco). The canonical ABI
  copies at the call boundary and allocates for lists; it describes
  calls, not shared memory.
- **Effect Schema as the source.** It describes values and validation,
  not memory layout, and making it the source would put Node inside the
  Rust build. The document schema in `packages/document` and the
  boundary schema answer different questions and stay separate.
- **Shared wasm linear memory with `+atomics`.** Zero copy, and real
  Rust atomics. The price is nightly and `-Z build-std` from day one.
  Worth revisiting when the multi-threaded mixer makes us pay it anyway.
- **Writing both sides by hand**, under golden vectors. This, not an
  off-the-shelf format, is the fallback if the generator turns out to
  cost more than it saves.
