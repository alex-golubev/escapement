import { type Id, readProjectId } from '@escapement/model'
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
}

export const ViewStore = Context.Service<ViewStore>('ViewStore')

/** Nothing kept: the windows open as a new project's each time. */
const unkept: ViewStore = { layout: Option.none(), saveLayout: () => Effect.void }

/** Where `store` keeps the project's layout. */
const layoutKey = (id: Id) => `layout:${id}`

/**
 * The view of the project that `id` names, in `store`, written only while `kept` holds: read as the page opens, and
 * written as asked; the page going away writes what still waits.
 */
export const viewStoreOf = Effect.fnUntraced(function* (
  store: KeyValueStore.KeyValueStore,
  id: Id,
  kept: () => boolean
) {
  const key = layoutKey(id)
  const views = KeyValueStore.toSchemaStore(store, SavedView)
  const saved = Option.flatten(yield* inTimeOrNone(views.get(key), 'The saved layout was left out'))
  /** What to write next, read as the write starts. */
  const waiting = yield* Ref.make(Option.none<() => unknown>())
  // A write under way finishes: an IndexedDB write interrupted is a write lost.
  const write = Effect.flatMap(Ref.getAndSet(waiting, Option.none()), (next) =>
    Option.match(Option.filter(next, kept), {
      onNone: () => Effect.void,
      onSome: (read) => Effect.suspend(() => views.set(key, { version: 1, layout: read() }))
    })
  ).pipe(
    Effect.uninterruptible,
    Effect.catchCause((cause) => Effect.logWarning("The layout wasn't saved", cause))
  )
  const saving = yield* FiberHandle.make<void, never>()
  const runFork = yield* FiberSet.makeRuntime<never>()
  const writeNow = () => runFork(FiberHandle.run(saving, write))
  const page = yield* Page
  yield* Effect.acquireRelease(
    Effect.sync(() => page.addEventListener('pagehide', writeNow)),
    () => Effect.sync(() => page.removeEventListener('pagehide', writeNow))
  )
  const view: ViewStore = {
    layout: Option.map(saved, (saved) => saved.layout),
    // A new one takes the place of one waiting.
    saveLayout: (read, { now }) =>
      Ref.set(waiting, Option.some(read)).pipe(
        Effect.andThen(
          FiberHandle.run(
            saving,
            Effect.delay(write, Boolean.match(now, { onTrue: () => Duration.zero, onFalse: () => saveAfter }))
          )
        ),
        Effect.asVoid
      )
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

/** The view kept for a deleted project gone; a failure is logged. */
export const forgetView = (id: Id) =>
  Effect.scoped(
    Effect.flatMap(
      Effect.flatMap(ViewStores, (stores) => stores.open),
      Option.match({
        onNone: () => Effect.void,
        onSome: (store) =>
          store
            .remove(layoutKey(id))
            .pipe(Effect.catch((error) => Effect.logWarning("The deleted project's layout wasn't forgotten", error)))
      })
    )
  )

/** The view of the project the page opened: a new project, with an ID of its own, starts with the first layout. */
export const viewStoreLayer = Layer.effect(
  ViewStore,
  Effect.gen(function* () {
    const session = yield* ProjectSession
    const registry = yield* AtomRegistry.AtomRegistry
    return yield* viewStoreFor(yield* KeptViews, session.doc, () => registry.get(session.saving))
  })
)
