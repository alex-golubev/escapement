import type { BuildThreadError, Engine, Rejection, SamplePcm, SampleUnavailable } from '@escapement/engine'
import type { Sha256 } from '@escapement/engine-description'
import type { ProjectAtoms } from '@escapement/model'
import { Boolean, Data, Deferred, Effect, Fiber, FiberMap, FiberSet, Option } from 'effect'
import { type Atom, AtomRegistry } from 'effect/reactivity'
import { type Built, changeTo, isEmpty, nothingBuilt, rebuildTo } from './changes'
import { type Client, type Picture, pictureOf, soundsOf } from './picture'

/** What became of a sound the project names. */
export type SoundStatus = Data.TaggedEnum<{
  Stored: {}
  Refused: { readonly reason: Rejection }
  /** Loading, checking or decoding it failed, so nothing went to the engine. */
  Unavailable: { readonly message: string }
  /** The library has no sound by this hash: what plays it stays silent. */
  Missing: {}
  Evicted: {}
}>

export const SoundStatus = Data.taggedEnum<SoundStatus>()

/** Where the sounds a project names come from, by their hashes, and who is told what became of them. */
export interface SoundLibrary {
  /** None if the library has no such sound. */
  readonly load: (hash: Sha256) => Option.Option<Effect.Effect<SamplePcm, SampleUnavailable>>
  readonly show: (hash: Sha256, status: SoundStatus) => Effect.Effect<void>
}

/**
 * Stores the sound and shows what became of it; a store its eviction stops shows nothing. The status of each sound the
 * page stores, the project's or not.
 */
export const storeWithStatus = (
  store: Engine['storeSample'],
  hash: Sha256,
  load: Effect.Effect<SamplePcm, SampleUnavailable>,
  show: (status: SoundStatus) => Effect.Effect<void>
): Effect.Effect<SoundStatus, BuildThreadError> =>
  store(hash, load).pipe(
    Effect.as(SoundStatus.Stored()),
    Effect.catchTags({
      SampleRefused: ({ reason }) => Effect.succeed(SoundStatus.Refused({ reason })),
      SampleUnavailable: ({ message }) => Effect.succeed(SoundStatus.Unavailable({ message }))
    }),
    Effect.tap(show)
  )

/** What the compiler needs of an engine, and whether it runs: one that doesn't takes nothing from the ring. */
export type CompiledEngine = Pick<Engine, 'send' | 'storeSample' | 'evictSample'> & {
  readonly running: Atom.Atom<boolean>
}

export interface Compiler {
  /**
   * A reset and the whole project in one transaction, as a new engine would get it, sounds that didn't get in tried
   * again. False if it found no room: then it goes with the next change, as one asleep goes once the engine runs.
   */
  readonly rebuild: Effect.Effect<boolean>
  /** Fails once a sound can't be stored because the build thread failed, or once building hits a bug; never succeeds. */
  readonly failure: Effect.Effect<never, BuildThreadError>
  /** Ends once no sound is on its way in: each asked for so far is in, or shown as not. Fails once building hit a bug. */
  readonly stored: Effect.Effect<void, BuildThreadError>
}

/**
 * Builds the project in the engine while the scope is open, as this client listens to it, holds its controls, plays it
 * and plays notes by hand: first all of it, then each change of any as one transaction. What it does is read by more
 * than one way, so it is written in batches (`batchedState`): a change reaches the engine whole. What the engine
 * has moves on only once a transaction is sent: one that finds no room is carried by the next. While the engine doesn't
 * run, nothing goes after the first build: the changes wait and go as one once it runs. The sounds follow the project whether the engine takes its
 * changes or not, each apart under its hash: one the nodes name is stored, one no node names any more is evicted, which
 * stops its store. One that didn't get in waits for a rebuild: tried on each change, a broken sound would load again at
 * every turn of a knob.
 */
export const compile = Effect.fnUntraced(function* (
  project: ProjectAtoms,
  client: Client,
  engine: CompiledEngine,
  library: SoundLibrary
) {
  const registry = yield* AtomRegistry.AtomRegistry
  const picture = pictureOf(project, client)
  const stores = yield* FiberMap.make<Sha256, void, BuildThreadError>()
  const run = yield* FiberMap.runtime(stores)()
  // What an atom sets off runs at once, here: a bug in it breaks the compiler, not whoever set the atom.
  const building = yield* FiberSet.make<boolean | void, never>()
  const runBuilding = yield* FiberSet.runtime(building)()
  /** Done only with the first bug building hit. */
  const broken = yield* Deferred.make<never>()
  const build = <A extends boolean | void>(work: () => A) =>
    runBuilding(Effect.sync(work).pipe(Effect.tapCause((cause) => Deferred.failCause(broken, cause))))
  /** Fails as building did, if it hit a bug. */
  const unbroken = Effect.flatMap(
    Deferred.poll(broken),
    Option.getOrElse(() => Effect.void)
  )
  const state: { built: Built; sent: boolean; rebuild: boolean; sounds: ReadonlyArray<Sha256> } = {
    built: nothingBuilt,
    sent: false,
    rebuild: false,
    sounds: []
  }
  /** Asked for and not in the engine: refused, unavailable or missing from the library. */
  const failed = new Set<Sha256>()

  const show = (hash: Sha256) => (status: SoundStatus) => library.show(hash, status)
  const store = (hash: Sha256) => {
    const stored: Effect.Effect<SoundStatus, BuildThreadError> = Option.match(library.load(hash), {
      onNone: () => Effect.succeed(SoundStatus.Missing()).pipe(Effect.tap(show(hash))),
      onSome: (load) => storeWithStatus(engine.storeSample, hash, load, show(hash))
    })
    run(
      hash,
      stored.pipe(
        Effect.tap((status) =>
          Effect.sync(() =>
            Boolean.match(SoundStatus.$is('Stored')(status), {
              onTrue: () => failed.delete(hash),
              onFalse: () => failed.add(hash)
            })
          )
        ),
        Effect.asVoid
      )
    )
  }

  const followSounds = (next: Picture) => {
    const sounds = soundsOf(next)
    const stored = state.sounds
    state.sounds = sounds
    sounds.filter((hash) => !stored.includes(hash)).forEach(store)
    // In place of its store, which it stops.
    stored
      .filter((hash) => !sounds.includes(hash))
      .forEach((hash) => {
        failed.delete(hash)
        Boolean.match(engine.evictSample(hash), {
          onTrue: () => run(hash, library.show(hash, SoundStatus.Evicted())),
          onFalse: () => {}
        })
      })
  }

  /** Sends what the engine lacks of the picture, unless it doesn't run and has had its first build. */
  const catchUp = (): boolean =>
    Boolean.match(state.sent && !registry.get(engine.running), {
      onTrue: () => true,
      onFalse: () => {
        const next = registry.get(picture)
        const { transaction, built } = Boolean.match(state.rebuild, {
          onTrue: () => rebuildTo(state.built, next),
          onFalse: () => changeTo(state.built, next)
        })
        return Boolean.match(isEmpty(transaction) || engine.send(transaction), {
          onFalse: () => false,
          onTrue: () => {
            state.built = built
            state.sent = true
            state.rebuild = false
            return true
          }
        })
      }
    })

  yield* Effect.acquireRelease(
    Effect.sync(() => [
      registry.subscribe(
        picture,
        (next) =>
          build(() => {
            catchUp()
            followSounds(next)
          }),
        { immediate: true }
      ),
      // At once: read first after it subscribed, the atom would call it again from inside a send.
      registry.subscribe(engine.running, () => build(catchUp), { immediate: true })
    ]),
    (unsubscribes) => Effect.sync(() => unsubscribes.forEach((unsubscribe) => unsubscribe()))
  )
  // The first build ran in the subscriptions: a bug in it fails the compile.
  yield* unbroken
  const compiler: Compiler = {
    rebuild: Effect.suspend(() =>
      Fiber.join(
        build(() => {
          state.rebuild = true
          const retried = state.sounds.filter((hash) => failed.has(hash))
          const sent = catchUp()
          retried.forEach(store)
          return sent
        })
      )
    ),
    // The stores' join ends as their scope closes; this one only ever fails.
    failure: Effect.raceFirst(FiberMap.join(stores), Deferred.await(broken)).pipe(Effect.andThen(Effect.never)),
    stored: Effect.raceFirst(Deferred.await(broken), FiberMap.awaitEmpty(stores)).pipe(Effect.andThen(unbroken))
  }
  return compiler
})
