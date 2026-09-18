# ADR-0017. A command record is a value, not a map of memory

- Status: accepted
- Date: 2026-09-18
- Supersedes the command offset assertions of [ADR-0015](0015-command-records-and-engine-abi.md)

## Context

[ADR-0013](0013-boundary-code-generation.md) makes a record's Rust layout
load-bearing. A record is reinterpreted from bytes, so if rustc lays it
out differently from the schema both sides still compile and the symptom
is a click in the audio. Hence the static assertion per field, and hence
rustc having the final word.

[ADR-0015](0015-command-records-and-engine-abi.md) gave command records
the same treatment: `#[repr(C)]`, the `offset_of!` assertions, and
`assert!(size_of::<T>() <= COMMAND_PAYLOAD_SIZE)`.

Writing the generator showed that the two are not the same kind of
thing. Nothing reads a command struct as memory. `Play::read` builds it
field by field with `from_le_bytes` at the offsets the schema states;
`write` reverses that; the TypeScript half does the same through a
`DataView`. The struct's own layout never takes part — which is also
what [ADR-0013](0013-boundary-code-generation.md) asks for, since
marshalling byte by byte is how the generated code says which end it is
writing from.

So the assertion guards nothing, and it costs something. A command whose
fields sit at 0 and at 8 passes every check in the schema, generates
TypeScript that reads and writes byte 8 correctly, and then fails to
compile in Rust:

```
error[E0080]: evaluation panicked: assertion failed:
              offset_of!(SetTempo, ramp_ms) == 8
```

Two halves of one boundary disagree about which schemas are legal, and
the diagnostic points at generated code without naming a cause.

## Decision

**A command record is a value.** Its fields are marshalled at the
schema's offsets, and its Rust layout is not part of the boundary.

- The generator emits no `offset_of!` assertion for a command.
- It still emits `assert!(size_of::<T>() <= COMMAND_PAYLOAD_SIZE)`. A
  command that does not fit its payload is an error, as
  [ADR-0015](0015-command-records-and-engine-abi.md) says.
- The struct keeps `#[repr(C)]`. Not because the boundary needs it, but
  because a predictable layout costs nothing. If a host ever does want
  to reinterpret a command, the assertions come back with it.
- **A command may leave a gap in its payload.** Reserving bytes for a
  field that does not exist yet is a reasonable thing to write, and
  nothing downstream is harmed by it.
- The alignment rule of [ADR-0015](0015-command-records-and-engine-abi.md)
  stands: a command still needs no alignment stronger than the payload
  offset provides. Marshalling does not require it, but the schema is a
  language-neutral description that a plugin author may choose to
  implement by reinterpretation, so the offsets stay aligned.

**Records are untouched.** They are reinterpreted — `tests/vectors.rs`
reads one straight out of its bytes — so
[ADR-0013](0013-boundary-code-generation.md)'s assertions stay exactly
as they are, as does the rule that a record's fields tile its size with
no hole.

## Consequences

- A schema the TypeScript half accepts is a schema the Rust half
  accepts. The generator has one answer to "is this legal", not two.
- Payload bytes can be reserved without inventing a placeholder field.
- One assertion fewer in the generated Rust. What it guarded — that the
  schema and rustc agree about a layout — is still guarded everywhere it
  means anything, which is records.
- If a command is ever reinterpreted from memory, this has to be
  revisited: repr(C) would only reproduce the schema's offsets if the
  declared gaps were written out as padding fields.

## Alternatives considered

- **Keep the assertions and fill declared gaps with padding fields.**
  Then repr(C) reproduces the schema's offsets by construction, provably,
  given the alignment check the schema already performs. Rejected because
  a private padding field stops `Play { from_frame: 4 }` compiling
  outside the crate, so every command would need a generated constructor
  — ceremony in service of an invariant nothing depends on.
- **Keep the assertions and teach the check to predict the C layout**, so
  that a rejected schema gets a sentence rather than a const-eval panic.
  It reads well, but it puts a layout algorithm inside the generator that
  [ADR-0013](0013-boundary-code-generation.md) deliberately kept out, and
  it still bans the reserved gap for nothing in return.
- **Keep the assertions and forbid gaps outright.** The smallest change
  of the three and the wrongest: it also rejects a `u8` at 0 beside a
  `u32` at 4, which is the layout repr(C) produces by itself.
- **Drop `#[repr(C)]` as well.** Consistent with the decision, but it
  buys nothing and gives up a predictable layout for free.
