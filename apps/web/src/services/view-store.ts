import { byContent, type Id, type PlayMode, playModes, readProjectId, storedId } from '@escapement/model'
import {
  Boolean,
  Context,
  Duration,
  Effect,
  FiberHandle,
  FiberSet,
  Layer,
  Option,
  Ref,
  Schema,
  type Scope
} from 'effect'
import { KeyValueStore } from 'effect/persistence'
import { AtomRegistry } from 'effect/reactivity'
import type * as Y from 'yjs'
import { inTimeOrNone } from './in-time'
import { Page } from './page'
import { ProjectSession, type Saving } from './session'

/** How the page keeps how a project is shown; a version other than this one's is left for the first layout. */
const SavedView = Schema.Struct({
  version: Schema.Literal(1),
  // In JSON of its own: the dock's has fields left undefined, which the store's JSON refuses.
  /** The windows as the dock writes them: the dock checks them as it reads them. */
  layout: Schema.fromJsonString(Schema.Unknown)
})

/** The pattern chosen, apart from the layout: a choice is written at once, the layout once the moves stop. */
const SavedPattern = Schema.Struct({ version: Schema.Literal(1), pattern: storedId })

/** What Play plays, Pattern or Arrangement, written at once as well. */
const SavedMode = Schema.Struct({ version: Schema.Literal(1), mode: Schema.Literals(playModes) })

/** Sizes and places change on every move of a drag: they are written once the moves stop. */
export const saveAfter = Duration.millis(300)

/** How this browser shows a project, kept for it alone: not in the project, and not on other devices. */
export interface ViewStore {
  /** The windows' layout saved when the page opened; none if none was, or it can't be read. */
  readonly layout: Option.Option<unknown>
  /**
   * Keeps the layout `read` gives as the write starts: at once, or, if nothing opened or closed, once the moves stop.
   * The page going away writes what still waits. A failure is logged.
   */
  readonly saveLayout: (read: () => unknown, options: { readonly now: boolean }) => Effect.Effect<void>
  /** The pattern chosen when the page opened; none if none was, or it can't be read. */
  readonly pattern: Option.Option<Id>
  /** Keeps the pattern chosen, at once. A failure is logged. */
  readonly savePattern: (pattern: Id) => Effect.Effect<void>
  /** The mode chosen when the page opened; none if none was, or it can't be read. */
  readonly mode: Option.Option<PlayMode>
  /** Keeps the mode chosen, at once. A failure is logged. */
  readonly saveMode: (mode: PlayMode) => Effect.Effect<void>
}

export const ViewStore = Context.Service<ViewStore>('ViewStore')

/** Nothing kept: the windows open as a new project's each time, its first pattern current and played. */
const unkept: ViewStore = {
  layout: Option.none(),
  saveLayout: () => Effect.void,
  pattern: Option.none(),
  savePattern: () => Effect.void,
  mode: Option.none(),
  saveMode: () => Effect.void
}

/** Where `store` keeps the project's layout. */
const layoutKey = (id: Id) => `layout:${id}`

/** Where `store` keeps the pattern chosen in the project. */
const patternKey = (id: Id) => `pattern:${id}`

/** Where `store` keeps the mode chosen in the project. */
const modeKey = (id: Id) => `mode:${id}`

/** A part of the view, kept under its key in `store` while `kept` holds. */
interface KeptPart<A> {
  /** As kept when the page opened; none if nothing was, or it can't be read. */
  readonly saved: Option.Option<A>
  /** Keeps what `read` gives as the write starts, once `delay` is over; a new one takes the place of one waiting. */
  readonly save: (read: () => A, delay: Duration.Duration) => Effect.Effect<void>
}

/** Read as the page opens, and written as asked; the page going away writes what still waits. */
const keptPart = <A, I>(
  store: KeyValueStore.KeyValueStore,
  schema: Schema.Codec<A, I>,
  key: string,
  kept: () => boolean,
  name: string
) =>
  Effect.gen(function* () {
    const parts = KeyValueStore.toSchemaStore(store, schema)
    const saved: Option.Option<A> = Option.flatten(
      yield* inTimeOrNone(parts.get(key), `The saved ${name} was left out`)
    )
    /** What to write next, read as the write starts. */
    const waiting = yield* Ref.make(Option.none<() => A>())
    // A write under way finishes: an IndexedDB write interrupted is a write lost.
    const write = Effect.flatMap(Ref.getAndSet(waiting, Option.none()), (next) =>
      Option.match(Option.filter(next, kept), {
        onNone: () => Effect.void,
        onSome: (read) => Effect.suspend(() => parts.set(key, read()))
      })
    ).pipe(
      Effect.uninterruptible,
      Effect.catchCause((cause) => Effect.logWarning(`The ${name} wasn't saved`, cause))
    )
    const saving = yield* FiberHandle.make<void, never>()
    const runFork = yield* FiberSet.makeRuntime<never>()
    const writeNow = () => runFork(FiberHandle.run(saving, write))
    const page = yield* Page
    yield* Effect.acquireRelease(
      Effect.sync(() => page.addEventListener('pagehide', writeNow)),
      () => Effect.sync(() => page.removeEventListener('pagehide', writeNow))
    )
    const part: KeptPart<A> = {
      saved,
      save: (read, delay) =>
        Ref.set(waiting, Option.some(read)).pipe(
          Effect.andThen(FiberHandle.run(saving, Effect.delay(write, delay))),
          Effect.asVoid
        )
    }
    return part
  })

/** The view of the project that `id` names, in `store`, written only while `kept` holds. */
export const viewStoreOf = Effect.fnUntraced(function* (
  store: KeyValueStore.KeyValueStore,
  id: Id,
  kept: () => boolean
) {
  // Together: each waits for a store that may not answer.
  const [layout, pattern, mode] = yield* Effect.all(
    [
      keptPart(store, SavedView, layoutKey(id), kept, 'layout'),
      keptPart(store, SavedPattern, patternKey(id), kept, 'pattern'),
      keptPart(store, SavedMode, modeKey(id), kept, 'mode')
    ],
    { concurrency: 'unbounded' }
  )
  const view: ViewStore = {
    layout: Option.map(layout.saved, (saved) => saved.layout),
    saveLayout: (read, { now }) =>
      layout.save(
        () => ({ version: 1, layout: read() }),
        Boolean.match(now, { onTrue: () => Duration.zero, onFalse: () => saveAfter })
      ),
    pattern: Option.map(pattern.saved, (saved) => saved.pattern),
    savePattern: (chosen) => pattern.save(() => ({ version: 1, pattern: chosen }), Duration.zero),
    mode: Option.map(mode.saved, (saved) => saved.mode),
    saveMode: (chosen) => mode.save(() => ({ version: 1, mode: chosen }), Duration.zero)
  }
  return view
})

/**
 * The view of the project in `doc`, by the project's ID, kept in `store` if there is one and the project is saved as
 * the page opens: an unsaved one's ID is the page's alone, and no page would read its layout again. Once the project is
 * deleted, nothing more is written; one whose saving stopped otherwise keeps its layout, in a store of its own.
 */
export const viewStoreFor = (store: Option.Option<KeyValueStore.KeyValueStore>, doc: Y.Doc, saving: () => Saving) =>
  Option.match(
    Option.zipWith(
      Option.filter(store, () => saving() === 'saved'),
      readProjectId(doc),
      (kept, id) => ({ kept, id })
    ),
    {
      onNone: () => Effect.succeed(unkept),
      onSome: ({ kept, id }) => viewStoreOf(kept, id, () => saving() !== 'erased-elsewhere')
    }
  )

/** This browser's store of views, opened for what is asked of it and closed with the scope: none if it doesn't open. */
export class ViewStores extends Context.Service<
  ViewStores,
  { readonly open: Effect.Effect<Option.Option<KeyValueStore.KeyValueStore>, never, Scope.Scope> }
>()('ViewStores') {}

/** The store of views, open as long as the page: none if it refuses or doesn't answer in time. */
export class KeptViews extends Context.Service<KeptViews, Option.Option<KeyValueStore.KeyValueStore>>()('KeptViews') {}

/** Opened beside the project, as the store doesn't need it. */
export const keptViewsLayer = Layer.effect(
  KeptViews,
  Effect.flatMap(ViewStores, (stores) => stores.open)
)

/** The view kept for a deleted project gone, each part apart: one that fails is logged, and the other goes still. */
export const forgetView = (id: Id) =>
  Effect.scoped(
    Effect.flatMap(
      Effect.flatMap(ViewStores, (stores) => stores.open),
      Option.match({
        onNone: () => Effect.void,
        onSome: (store) =>
          Effect.forEach(
            [layoutKey(id), patternKey(id), modeKey(id)],
            (key) =>
              store
                .remove(key)
                .pipe(
                  Effect.catch((error) => Effect.logWarning(`The deleted project's ${key} wasn't forgotten`, error))
                ),
            { discard: true }
          )
      })
    )
  )

/**
 * The pattern and the mode kept last are this page's again, and each one chosen on the page is kept, while the scope is
 * open.
 */
export const keepListening = Effect.fnUntraced(function* (view: ViewStore, session: ProjectSession) {
  const registry = yield* AtomRegistry.AtomRegistry
  Option.map(view.pattern, session.choosePattern)
  Option.map(view.mode, session.chooseMode)
  const chosen = byContent((get) => get(session.listening).pattern)
  const runFork = yield* FiberSet.makeRuntime<never>()
  const kept = (subscribe: () => () => void) =>
    Effect.acquireRelease(Effect.sync(subscribe), (unsubscribe) => Effect.sync(unsubscribe))
  yield* kept(() => registry.subscribe(chosen, (pattern) => Option.map(pattern, (id) => runFork(view.savePattern(id)))))
  yield* kept(() => registry.subscribe(session.mode, (mode) => runFork(view.saveMode(mode))))
})

/** The view of the project the page opened: a new project, with an ID of its own, starts with the first layout. */
export const viewStoreLayer = Layer.effect(
  ViewStore,
  Effect.gen(function* () {
    const session = yield* ProjectSession
    const registry = yield* AtomRegistry.AtomRegistry
    const view = yield* viewStoreFor(yield* KeptViews, session.doc, () => registry.get(session.saving))
    yield* keepListening(view, session)
    return view
  })
)
