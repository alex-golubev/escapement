# ADR-0015. Command records and the engine ABI surface

- Status: accepted, amended by [ADR-0017](0017-command-records-are-values.md)
- Date: 2026-09-18

## Context

[ADR-0013](0013-boundary-code-generation.md) settled how the boundary
code is generated: explicit offsets in the schema, a generator that
computes no layout and only checks alignment and overlap, records of
fixed size, nothing optional and nothing of variable length.

Writing the first commands against that description exposes two things
it does not answer.

**A single ring carries commands of different kinds.** `NoteOn` needs a
pitch and a velocity, `SetTempo` needs a tempo, `SetParam` needs a
target and a value. A record whose fields are the union of every
command's fields grows with the command set, and we copy a slot per
block. A payload reinterpreted per kind is the same bytes in the same
place read two ways — which is exactly what the generator's overlap
check exists to reject, and turning that check off would give back the
padding risk [ADR-0013](0013-boundary-code-generation.md) was written
to remove.

**The schema does not describe the calls.** It covers record layouts,
enum codes, constants and the ABI version. But the worklet glue also
has to know where to put the records it drained, what to call, and in
what order — the engine's exported functions. That surface is neither
the schema nor the ring container, so today it has no home, and the
glue cannot be written without it.

## Decision

### A slot is a header and a payload

The ring carries slots of one fixed size. A slot is:

| Offset | Field | Type |
|---|---|---|
| 0 | `kind` | `u32` |
| 4 | `frame_offset` | `u32` |
| 8 | payload | opaque bytes |

`frame_offset` places the command inside the block it belongs to. It
costs four bytes now and buys sample-accurate note timing later;
without it every event in a 128-frame block lands on the block
boundary, which is 2.67 ms of quantisation at 48 kHz and audible on
anything percussive. Blocks are larger in offline rendering, so the
field is `u32` rather than `u16`.

The slot size is one constant in the schema. It starts at 32 bytes —
8 of header and 24 of payload — and changing it changes the ABI hash
like any other edit.

### One record per command kind

Each kind of command is its own record in the schema, with its own
offsets counted from the start of the payload. There is no union and
no reinterpretation: `NoteOn` and `SetTempo` are two records that
happen to be written at the same place in different slots.

The generator then checks, per command record:

- alignment and overlap **within** that record, exactly as before;
- that its size fits the payload;
- that it needs no alignment stronger than the payload offset provides.

and emits, per command record:

- Rust: a `#[repr(C)]` struct, the `offset_of!` assertions of
  [ADR-0013](0013-boundary-code-generation.md), and
  `assert!(size_of::<NoteOn>() <= COMMAND_PAYLOAD_SIZE)`
  (the offset assertions were withdrawn by
  [ADR-0017](0017-command-records-are-values.md); the size one stands);
- TypeScript: a writer taking the slot base, which adds the payload
  offset itself so no caller ever does that arithmetic.

Across kinds there is nothing to check, because across kinds there is
no shared layout. The generator still computes nothing.

Decoding stays hand-written: the generator emits the `kind` enum and
its fallible conversion, the `match` over kinds lives in the engine and
returns a `Result`, and a slot whose kind is unknown is dropped and
counted ([ADR-0002](0002-engine-rust-wasm-audioworklet.md)).

### The exported functions are part of the schema

The schema gains a section that names the engine's exports and their
signatures. The generator emits a TypeScript type for them, so the glue
is checked against the same source as the records rather than against a
comment.

The stage 0 surface:

```
abi_version()             -> u32
init(sample_rate, max_block_frames) -> u32   // 0 on success
command_staging_ptr()     -> u32
command_staging_capacity() -> u32
audio_out_ptr()           -> u32
meter_block_ptr()         -> u32
process(command_count, frames) -> u32        // 0 on success
```

Three rules come with it.

**The version is checked at instantiation.** The glue compares
`abi_version()` against the constant generated from the same schema and
refuses to create the node if they differ. A stale `.wasm` beside fresh
TypeScript is otherwise silent corruption: the offsets simply mean
something else.

**The engine never grows its memory after `init`.** Growing wasm memory
detaches every `TypedArray` the JavaScript side holds over it, so the
glue would keep writing into a dead view and the engine would read
nothing — silence with no error anywhere. Buffers are sized in `init`
and pooled from then on, which
[ADR-0002](0002-engine-rust-wasm-audioworklet.md) already requires of
the audio path for its own reasons.

**Instantiation happens in the processor's constructor.** `process()`
only calls the export. Compiling on the main thread and handing over a
ready `WebAssembly.Module`
([ADR-0002](0002-engine-rust-wasm-audioworklet.md)) makes
`new WebAssembly.Instance` synchronous and legal there.

### What the vectors may assert

The golden vectors of [ADR-0011](0011-engine-boundary-schema.md) assert
**byte-for-byte** agreement for record layouts, enum codes, the ABI
version and musical time arithmetic. That is integer work and both
sides must produce identical answers.

They do **not** assert bit-identical audio between hosts. Comparisons
of rendered samples between `engine-native` and `engine-wasm` carry a
tolerance, because the two go through different LLVM backends —
`simd128` against SSE or NEON, with different freedom to contract a
multiply and an add into one instruction. A test suite that demands
sample-exact agreement there goes red for reasons no one can fix, and a
test people learn to ignore is worse than no test.

This leaves a real question open, and this ADR does not answer it:
[ADR-0002](0002-engine-rust-wasm-audioworklet.md) says a render is
fully determined by the document plus asset and plugin versions, and a
project exported on the server should match what the musician heard in
the browser. Whether that holds bit for bit across the two hosts, and
what it costs to make it hold, is to be settled by measurement once
there is a synth to measure — not assumed now.

## Consequences

- The slot stays small and constant while the command set grows.
- A new command is a new record in the schema; nothing else moves, and
  the ABI hash records that something changed.
- The generator keeps its one virtue: it computes no layout.
- The glue is type-checked against the exports rather than against
  prose, and a mismatched binary fails loudly at startup.
- The schema now describes calls as well as memory, which is a little
  more than [ADR-0011](0011-engine-boundary-schema.md) promised. It is
  still declarative and still language-neutral.
- We accept a tolerance in cross-host audio comparisons and owe
  ourselves a measurement before claiming deterministic export.

## Alternatives considered

- **One flat slot with the union of every command's fields.** No
  overlap and no new concept, but the slot grows with the command set,
  and we copy it every block for the life of the project.
- **A payload reinterpreted per kind inside one record.** The same
  bytes as this decision, obtained by disabling the check that makes
  the generator worth having.
- **A `#[repr(C)] union` on the Rust side.** Unsafe reads with nothing
  gained: the per-kind struct gives the same bytes and keeps the
  static assertions.
- **Variable-length commands.** Serialization, on a path that permits
  none ([ADR-0013](0013-boundary-code-generation.md)).
- **The exports described in prose** in a crate README. It drifts, and
  nothing fails when it does.
- **The exports described by wasm-bindgen.** Rejected in
  [ADR-0014](0014-tooling-and-ci.md): a second description of a
  boundary that has one.
