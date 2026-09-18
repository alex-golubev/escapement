# ADR-0018. Functional by default, free functions on the audio path

- Status: accepted
- Date: 2026-09-18
- Supersedes the class-style accessors of [ADR-0013](0013-boundary-code-generation.md)

## Context

[ADR-0005](0005-ts-stack-effect-svelte.md) puts Effect on both sides of the application and says nothing about the rest. [ADR-0013](0013-boundary-code-generation.md) asked for "class-style accessors … for cold paths such as reading meters once a frame"; writing them produced the only object with identity and mutable state in the repository, inside a generated file, which is where an exception is least likely to be revisited.

One constraint shapes any answer: [ADR-0002](0002-engine-rust-wasm-audioworklet.md) forbids allocation on the audio path, and closures, Effect wrappers and object snapshots all allocate.

## Decision

- Functional wherever it is possible: free functions and plain immutable data rather than objects carrying identity and mutable state. This covers generated code as much as hand-written code.
- The audio path keeps plain free functions, and that is not an exception to the rule. `readCommandSlotKind(view, base)` takes data and returns data, so it is already the functional shape and the only one that allocates nothing.
- A cold-path read is a snapshot rather than a view: `readMeterBlock(atoms, base)` returns the values. Writes stay the separate `store…` and `write…` functions, so changing shared memory is a call that says so rather than an assignment behind a setter.
- This retires "class-style accessors are emitted as well" from [ADR-0013](0013-boundary-code-generation.md). The snapshot serves what that clause was for, and matches the shape the generator already emits for commands.
- Effect stops at the boundary package: `packages/protocol` has no dependencies and its functions run inside `process()`.

## Consequences

- One shape for a cold-path read, the same for records and commands.
- A snapshot is where a seqlock would go if the meter block turns out to need one. Independent getters had nowhere to put such a check.
- One object allocated per cold-path read, which is what makes it a cold path.

## Alternatives considered

- **A factory returning frozen closures.** Functional in shape, but it allocates a closure per field per call and buys nothing the snapshot does not.
- **Wrap the accessors in Effect.** Consistent with [ADR-0005](0005-ts-stack-effect-svelte.md) and unusable: it allocates on the audio path.
