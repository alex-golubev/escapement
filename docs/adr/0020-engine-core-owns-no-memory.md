# ADR-0020. The engine core owns no memory

- Status: accepted
- Date: 2026-09-18
- Amends the stage 0 export surface of [ADR-0015](0015-command-records-and-engine-abi.md)

## Context

[ADR-0002](0002-engine-rust-wasm-audioworklet.md) forbids allocation, locks and panics on the audio path. [ADR-0015](0015-command-records-and-engine-abi.md) adds two rules the boundary rests on: the exported pointers stay valid for the life of the instance, because JavaScript caches typed arrays over them, and the engine never grows its memory after `init`, because growing detaches every one of those views.

Writing the first engine against that description exposes the question it leaves open: who owns the buffers the boundary names, and how big are they. [ADR-0015](0015-command-records-and-engine-abi.md) answers "buffers are sized in `init` and pooled from then on", which assumes the engine allocates them and then maintains, by discipline, both the absence of allocation later and the stability of the pointers it handed out.

The schema names three pieces of memory — the command staging area, the audio output buffer and the meter block — and states the size of none of them. The sizes exist regardless: something decides how many slots staging holds and how many frames fit in the output buffer. Chosen inside the engine, those numbers sit where the TypeScript half cannot see them and has to be told, or guess. That is the shape of the divergence [ADR-0011](0011-engine-boundary-schema.md) exists to prevent, and it is worth settling before any of it is written rather than after.

## Decision

### The core is plain data and functions over it

`engine-core` is `#![no_std]`, without `alloc`, and `#![forbid(unsafe_code)]`. It holds no buffer, owns no pointer and allocates nothing. Everything it works on arrives from the caller as slices and references.

### The host owns the memory

`engine-wasm` holds it in statics, reached as `&raw mut` — the only `unsafe` in the engine crates. `engine-native` holds it in a `Vec`. The same core, two owners, and the one that runs in the browser is the one with no allocator at all.

### A size a static needs is a size the schema states

A static's size is known when the code is compiled. So every buffer the boundary names has a compile-time size, and the schema is where that number is written: `records.audio_out` is an ordinary fixed-size record with offsets written by hand, and `command_staging_capacity` is an ordinary constant. Both sides read the same numbers out of the same file, and the generator checks them the way it checks everything else — alignment, overlap, and fields that tile the size.

For the audio buffer this also answers a question the schema could not otherwise state: a plane is at a fixed offset rather than a stride computed from the block size, so the two halves cannot disagree about where the right channel begins. `frames` stops being part of the layout and becomes what it is, the number of samples in the plane that this block filled.

### `init` no longer takes a maximum block size

The export becomes `init(sample_rate) -> u32`. The parameter sized the buffers; the schema sizes them now, and a second number describing the same limit is a second thing that can disagree. `process` checks `frames` against the schema's maximum and reports `bad_frame_count`. This amends the stage 0 surface of [ADR-0015](0015-command-records-and-engine-abi.md).

### The engine's report is not the published meter block

`meter_block_ptr()` becomes `engine_report_ptr()`, and the schema describes two records instead of one. `engine_report` lives in unshared wasm memory: the core writes it, the glue reads it through a `DataView`. `meter_block` lives in the shared buffer: the glue publishes it with `Atomics.store` and the UI reads it every frame. The glue copies field by field either way, because no path runs from wasm memory into a `SharedArrayBuffer` except through `Atomics`.

One record for both residences bought nothing and cost two things: a comment claiming the engine never touches memory that it does in fact write, and a generator that emits only atomic accessors for a record which is also read through a plain `DataView`. This too amends [ADR-0015](0015-command-records-and-engine-abi.md).

### The core does not take the boundary's records

`process` in the core takes slices, not `&mut AudioOut`. The record is the memory map of one host, the one that talks to JavaScript; `engine-native` is not on the boundary and is not bound by a size chosen for the browser.

## Consequences

- "No allocation in `process()`" stops being a promise and becomes a property: the core has no allocator to call.
- The exported pointers are stable by construction. With a `Vec` it would be a rule someone has to keep.
- Staging is a `[CommandSlot; COMMAND_STAGING_CAPACITY]`: a typed array the engine indexes, not bytes it reinterprets. No `transmute`, no `bytemuck`.
- The engine's state is the host's data, so the core has to be `const`-constructible and its voice pool is a fixed-size array. A pool that grows with the project is out, and that is the price of this decision.
- Raising a buffer's maximum moves the ABI hash, which is correct: it moves a plane and the offsets JavaScript holds.
- The module carries its maximum whether it uses it or not — 8 KB of wasm memory for an output buffer that a browser block fills a sixteenth of.
- Two numbers that used to be the engine's business are now part of the ABI, so changing them is a schema edit under review rather than a constant somebody moves.

## Alternatives considered

- **The core owns its buffers, sized in `init`**, as [ADR-0015](0015-command-records-and-engine-abi.md) assumed. It puts an allocator in the module, and a `Vec` that is ever reallocated moves memory JavaScript holds views over: the rule about not growing wasm memory again, one level down, with nothing to enforce it.
- **A schema section for buffers sized at run time**, describing the audio buffer's plane stride as an expression the generator emits. The buffer stays sized by `init`, at the price of a generator that emits layout arithmetic — precisely what [ADR-0013](0013-boundary-code-generation.md) keeps out of it. A compile-time maximum removes the stride question instead of managing it.
- **`max_block_frames` kept as a bound the host declares**, checked against the schema's maximum at `init`. It is tighter by exactly one case, a host asking for more than it promised but less than the schema allows, and it costs two limits behind one error code and a promise stored in the engine's state.
- **One meter record for both residences**, with a comment explaining the difference. Cheaper by one record, but the comment has to carry a semantic difference that the field names then contradict.
- **A fixed block size for everyone**, with no maximum and no `frames` argument. The browser's render quantum is 128 and offline rendering wants larger blocks ([ADR-0015](0015-command-records-and-engine-abi.md)); one number cannot be both.
