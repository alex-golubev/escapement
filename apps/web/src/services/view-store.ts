import { type Id, readProjectId, storedId } from '@escapement/model'
import { Context, Effect, Layer, Option, Schema, type Scope } from 'effect'
import { KeyValueStore } from 'effect/persistence'
import { AtomRegistry } from 'effect/reactivity'
import type * as Y from 'yjs'
import { inTimeOrNone } from './in-time'
import { ProjectSession, type Saving } from './session'

/** What the middle of the page shows, in the order of its buttons. */
export const centres = ['arrangement', 'mixer', 'debug'] as const

export const Centre = Schema.Literals(centres)

export type Centre = typeof Centre.Type

/** What the middle can show in a build: only one for development has Debug. */
export const centresFor = (development: boolean) => centres.filter((centre) => development || centre !== 'debug')

/** What the panel under the middle shows: a track, or the notes of a clip. */
export const Shown = Schema.TaggedUnion({ Track: { track: storedId }, Notes: { clip: storedId } })

export type Shown = typeof Shown.Type

/** How the project is shown: what the middle shows, and what the panel under it does, if anything. */
export const View = Schema.Struct({ centre: Centre, below: Schema.OptionFromNullOr(Shown) })

export type View = typeof View.Type

/** As a new project is shown: the Arrangement, with nothing under it yet. */
export const firstView: View = { centre: 'arrangement', below: Option.none() }

/** How the page keeps how a project is shown; a version other than this one's is left for the first view. */
const SavedView = Schema.Struct({ version: Schema.Literal(2), ...View.fields })

/** How this browser shows a project, kept for it alone: not in the project, and not on other devices. */
export interface ViewStore {
  /** The view saved when the page opened; none if none was, or it can't be read. */
  readonly saved: Option.Option<View>
  /** Keeps the view; the write, once started, finishes. A failure is logged. */
  readonly save: (view: View) => Effect.Effect<void>
}

export const ViewStore = Context.Service<ViewStore>('ViewStore')

/** Nothing kept: the project is shown as a new one's each time. */
const unkept: ViewStore = { saved: Option.none(), save: () => Effect.void }

/** Where `store` keeps the project's view. */
const layoutKey = (id: Id) => `layout:${id}`

/** The view of the project that `id` names, in `store`, written only while `kept` holds: read as the page opens. */
export const viewStoreOf = Effect.fnUntraced(function* (
  store: KeyValueStore.KeyValueStore,
  id: Id,
  kept: () => boolean
) {
  const key = layoutKey(id)
  const views = KeyValueStore.toSchemaStore(store, SavedView)
  const saved = Option.flatten(yield* inTimeOrNone(views.get(key), 'The saved view was left out'))
  // A write under way finishes: an IndexedDB write interrupted is a write lost.
  const write = (view: View) =>
    Effect.suspend(() =>
      Option.match(Option.liftPredicate(view, kept), {
        onNone: () => Effect.void,
        onSome: (keeping) => views.set(key, { version: 2, ...keeping })
      })
    ).pipe(
      Effect.uninterruptible,
      Effect.catchCause((cause) => Effect.logWarning("The view wasn't saved", cause))
    )
  const view: ViewStore = { saved: Option.map(saved, ({ centre, below }) => ({ centre, below })), save: write }
  return view
})

/**
 * The view of the project in `doc`, by the project's ID, kept in `store` if there is one and the project is saved as
 * the page opens: an unsaved one's ID is the page's alone, and no page would read its view again. Once the project is
 * deleted, nothing more is written; one whose saving stopped otherwise keeps its view, in a store of its own.
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
            .pipe(Effect.catch((error) => Effect.logWarning("The deleted project's view wasn't forgotten", error)))
      })
    )
  )

/** The view of the project the page opened: a new project, with an ID of its own, starts with the first view. */
export const viewStoreLayer = Layer.effect(
  ViewStore,
  Effect.gen(function* () {
    const session = yield* ProjectSession
    const registry = yield* AtomRegistry.AtomRegistry
    return yield* viewStoreFor(yield* KeptViews, session.doc, () => registry.get(session.saving))
  })
)
