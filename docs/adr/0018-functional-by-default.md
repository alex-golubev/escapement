# ADR-0018. Functional by default, free functions on the audio path

- Status: accepted
- Date: 2026-09-18
- Supersedes the class-style accessors of [ADR-0013](0013-boundary-code-generation.md)

## Context

[ADR-0005](0005-ts-stack-effect-svelte.md) puts Effect on both sides of
the application, which settles the paradigm for everything built on it
and says nothing about the rest.

[ADR-0013](0013-boundary-code-generation.md), describing what the
boundary generator emits, asked for "class-style accessors … for cold
paths such as reading meters once a frame". Writing them produced the
only class in the repository, and it sits oddly next to everything else:
it holds a `DataView` and a base, it hands out identity, and it mutates
through setters.

Any answer here has to survive one constraint.
[ADR-0002](0002-engine-rust-wasm-audioworklet.md) forbids allocation on
the audio path, and [ADR-0013](0013-boundary-code-generation.md) wants
the hot-path accessors monomorphic and inlinable. Closures, Effect
wrappers and object snapshots all allocate.

## Decision

**Functional wherever it is possible.** Free functions and plain
immutable data rather than objects that carry identity and mutable
state. This covers generated code as much as hand-written code: what the
generator emits is code the project owns and reads.

**The audio path keeps plain free functions, and that is not an
exception to the rule.** `readCommandSlotKind(view, base)` takes data
and returns data. It has no identity and no state, so it is already the
functional shape — and it is the only shape that allocates nothing. The
rule and [ADR-0002](0002-engine-rust-wasm-audioworklet.md) agree here
rather than pulling against each other.

**A cold-path read is a snapshot, not a view.** In place of the class:

```ts
export function readMeterBlock(atoms: Int32Array, base: number) {
  return {
    blockCounter: loadMeterBlockBlockCounter(atoms, base),
    positionFrames: loadMeterBlockPositionFrames(atoms, base),
    peakMicro: loadMeterBlockPeakMicro(atoms, base),
    transportState: loadMeterBlockTransportState(atoms, base),
  }
}
```

Writes stay the separate `store…` and `write…` functions, so changing
shared memory is a call that says so rather than an assignment hidden
behind a setter.

This retires "Class-style accessors are emitted as well for cold paths"
from [ADR-0013](0013-boundary-code-generation.md). What that clause was
for — a cold-path read that is pleasant to use — the snapshot serves
better, and it matches the shape the generator already emits for
commands (`readPlay`, `readSetTempo`).

**Effect stops at the boundary package.** `packages/protocol` has no
dependencies and its functions run inside `process()`.
[ADR-0005](0005-ts-stack-effect-svelte.md)'s "Effect everywhere" is
about the application; wrapping these accessors would allocate on the
audio path.

## Consequences

- One shape for a cold-path read, the same for records and commands.
- A snapshot is where a seqlock would go if the meter block turns out to
  need one — `block_counter` looks like the guard for exactly that. Four
  independent getters had nowhere to put such a check.
- One object allocated per cold-path read, which is what makes it a cold
  path.
- A reviewer has a rule to point at, instead of an argument about taste.

## Alternatives considered

- **Keep the class.** It would leave the single object with identity in
  the repository inside a generated file, which is the worst place for
  an exception: nobody edits it, so nobody revisits it.
- **A factory returning frozen closures.** Functional in shape, but it
  allocates a closure per field per call and buys nothing the snapshot
  does not.
- **Wrap the accessors in Effect.** Consistent with
  [ADR-0005](0005-ts-stack-effect-svelte.md) and unusable: it allocates
  on the audio path.
- **Keep the class and apply the rule only to new code.** The rule would
  then be contradicted by the one file every reader of the boundary
  opens first.
