# ADR-0017. A command record is a value, not a map of memory

- Status: accepted
- Date: 2026-09-18
- Supersedes the command offset assertions of [ADR-0015](0015-command-records-and-engine-abi.md)

## Context

[ADR-0013](0013-boundary-code-generation.md) makes a record's Rust layout load-bearing: a record is reinterpreted from bytes, so if rustc lays it out differently from the schema, both sides compile and the symptom is a click in the audio. [ADR-0015](0015-command-records-and-engine-abi.md) gave command records the same `offset_of!` assertions.

Nothing reads a command struct as memory. `read` and `write` marshal it field by field at the schema's offsets, so the assertion guards nothing and rejects layouts the boundary allows: a command with fields at 0 and at 8 passes every check, generates correct TypeScript, then fails to compile in Rust with a const-eval panic that names no cause.

## Decision

- A command record is a value. Its fields are marshalled at the schema's offsets; its Rust layout is not part of the boundary and carries no assertion.
- `assert!(size_of::<T>() <= COMMAND_PAYLOAD_SIZE)` stays: a command must fit its payload.
- The struct keeps `#[repr(C)]`. A predictable layout costs nothing, and if a host ever reinterprets a command the assertions come back with it.
- A command may leave a gap in its payload, reserving bytes for a field that does not exist yet.
- The alignment rule of [ADR-0015](0015-command-records-and-engine-abi.md) stands. Marshalling does not need it, but the schema is language-neutral and a plugin author may implement it by reinterpretation.
- Records are unchanged: they are reinterpreted, so [ADR-0013](0013-boundary-code-generation.md)'s assertions and the no-hole rule stay.

## Consequences

- A schema the TypeScript half accepts is one the Rust half accepts. The generator has one answer to "is this legal", not two.
- Payload bytes can be reserved without inventing a placeholder field.
- One assertion fewer, still guarded everywhere it means anything, which is records.
- If a command is ever reinterpreted from memory, this has to be revisited: the declared gaps would have to be written out as padding.

## Alternatives considered

- **Fill declared gaps with generated padding fields.** repr(C) would reproduce the schema's offsets by construction, but a private padding field stops `Play { from_frame: 4 }` compiling outside the crate and forces a constructor on every command.
- **Teach the check to predict the C layout**, so a rejected schema gets a sentence instead of a const-eval panic. It puts a layout algorithm in the generator that [ADR-0013](0013-boundary-code-generation.md) kept out, and still bans the reserved gap.
- **Forbid gaps outright.** Also rejects a `u8` at 0 beside a `u32` at 4, which is the layout repr(C) produces by itself.
