import { Cause, Effect, Exit, Fiber, Option, Scope } from 'effect'

/** What the page keeps in IndexedDB is small and answers in milliseconds: storage that takes longer won't answer. */
export const storageTimeout = '5 seconds'

/** What `running` gives, or none if it fails, dies or doesn't answer in time; it goes on all the same. */
const joinedInTime = <A, E>(running: Fiber.Fiber<A, E>, failed: string) =>
  Fiber.join(running).pipe(
    Effect.timeout(storageTimeout),
    Effect.asSome,
    Effect.catchCause((cause) => Effect.as(Effect.logWarning(failed, cause), Option.none<A>()))
  )

/**
 * What `effect` gives, or none if it fails, dies or doesn't answer in time. It runs apart, so the page doesn't wait
 * for IndexedDB that hangs where it can't be interrupted, as in opening a database: such a store costs what it keeps,
 * not the page.
 */
export const inTimeOrNone = <A, E, R>(effect: Effect.Effect<A, E, R>, failed: string) =>
  Effect.flatMap(Effect.forkDetach(effect), (running) => joinedInTime(running, failed))

/**
 * What `open` gives in a scope of its own, or none, as `inTimeOrNone`. Its scope closes with the caller's, once `open`
 * is done: a database that opened after its scope closed would stay open, holding up any page that changes its version
 * or erases it.
 */
export const openInTimeOrNone = <A, E, R>(open: (scope: Scope.Scope) => Effect.Effect<A, E, R>, failed: string) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make()
    const opening = yield* Effect.forkDetach(open(scope))
    yield* Effect.addFinalizer(() =>
      Effect.forkDetach(Effect.andThen(Fiber.await(opening), Scope.close(scope, Exit.void)))
    )
    return yield* joinedInTime(opening, failed)
  })

/**
 * What `effect` gives, or `refused` with why not. Storage that doesn't answer in time stands for one that refuses; so
 * does one that throws, as IndexedDB does on a connection the browser closed.
 */
export const inTimeOrRefused = <A, E, R, X>(effect: Effect.Effect<A, E, R>, refused: (cause: unknown) => X) =>
  effect.pipe(
    Effect.catchCause((cause) => Effect.fail(refused(Cause.squash(cause)))),
    Effect.timeoutOrElse({
      duration: storageTimeout,
      orElse: () => Effect.fail(refused("the browser's storage didn't answer in time"))
    })
  )
