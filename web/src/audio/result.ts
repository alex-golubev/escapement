// Failure as a value, on the page's side of the thread boundary.
//
// A file of its own from the moment a second module needed it. The alternative
// was `audio/kit.ts` importing this out of `host.ts`, which is where it used to
// live — an edge from a leaf to the module that composes everything, carrying
// one type and pointing backwards.
//
// **It is deliberately not shared with the worklet**, which declares the same
// three names in `worklet/engine.ts`. The argument is written there and belongs
// there: the two sides never exchange these values, so one type across both
// would link them by name without linking anything real.

/**
 * Not Effect's `Result`, which is a different type with this name, the same
 * parameter order and a shape that is not this one — `_tag` with `success` and
 * `failure` where this has `ok` with `value` and `error`. Both are in reach of
 * `audio/`: `Effect.result` produces theirs, and `audio/kit.ts` already returns
 * Effects. Import one or the other deliberately; the two do not interchange and
 * nothing but the field names will say so.
 *
 * This one is on its way out. `audio/kit.ts` no longer uses it, and `host.ts`
 * is what still does — when that goes to Effect, what remains here is
 * `messageOf`, and the worklet's own copy of these three names stays where it
 * is, because the worklet never takes Effect at all.
 */
export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E }

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value })
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error })

/**
 * The message of something thrown, whatever was thrown.
 *
 * Written out again in `worklet/engine.ts`, and the copy is on purpose: sharing
 * one line of the canonical `instanceof Error` check would mean the worklet
 * bundle importing from this side of the boundary, and the point of the
 * boundary is that it does not. If either copy grows a rule, the other gets it
 * too.
 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
