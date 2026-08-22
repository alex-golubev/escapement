// Taking the value, or the failure, out of a result in a test.
//
// Typed structurally because there is no shared type to import: engine.ts and
// host.ts each declare their own, deliberately. Matching on the shape is what
// lets one helper cover both.
//
// Nothing here covers an Effect, and that is not an omission. `@effect/vitest`
// runs one for a test and reports its failure, and `Effect.flip` is how a test
// asserts on that failure — a helper of ours beside them would be a second way
// to do what the official one already does.
//
// Both throw — right here, where the throw carries the failure into the report
// instead of letting an assertion run against the wrong branch.

type Fallible<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E }

export function unwrapValue<T, E>(result: Fallible<T, E>): T {
  if (!result.ok) throw new Error(`expected success, got ${JSON.stringify(result.error)}`)
  return result.value
}

export function unwrapError<T, E>(result: Fallible<T, E>): E {
  if (result.ok) throw new Error('expected a failure, got a success')
  return result.error
}
