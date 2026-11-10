import { Context, Effect, Layer, Option, Schema } from 'effect'
import { KeyValueStore } from 'effect/persistence'
import { Atom, AtomRegistry } from 'effect/reactivity'
import { inTimeOrNone } from './in-time'
import { KeptViews } from './view-store'

/** How this browser is set for every project, kept beside the views: not in a project, and not on other devices. */
export interface Preferences {
  /** Whether the engine's load is measured; on until switched off. */
  readonly measureLoad: Atom.Atom<boolean>
  readonly setMeasureLoad: (on: boolean) => Effect.Effect<void>
}

export const Preferences = Context.Service<Preferences>('Preferences')

const SavedPreferences = Schema.Struct({ measureLoad: Schema.Boolean })

const preferencesKey = 'preferences'

/** Read as the page opens; with no store, as a new browser's, for as long as the page is open. */
export const preferencesLayer = Layer.effect(
  Preferences,
  Effect.gen(function* () {
    const registry = yield* AtomRegistry.AtomRegistry
    const store = Option.map(yield* KeptViews, (kept) => KeyValueStore.toSchemaStore(kept, SavedPreferences))
    const saved = yield* Option.match(store, {
      onNone: () => Effect.succeedNone,
      onSome: (kept) =>
        Effect.map(inTimeOrNone(kept.get(preferencesKey), 'The preferences were left out'), Option.flatten)
    })
    const measureLoad = Atom.make(Option.match(saved, { onNone: () => true, onSome: (kept) => kept.measureLoad })).pipe(
      Atom.keepAlive
    )
    const setMeasureLoad = (on: boolean) =>
      Effect.sync(() => registry.set(measureLoad, on)).pipe(
        Effect.andThen(
          Option.match(store, {
            onNone: () => Effect.void,
            onSome: (kept) =>
              kept.set(preferencesKey, { measureLoad: on }).pipe(
                // A write under way finishes: an IndexedDB write interrupted is a write lost.
                Effect.uninterruptible,
                Effect.catchCause((cause) => Effect.logWarning("The preferences weren't saved", cause))
              )
          })
        )
      )
    return { measureLoad, setMeasureLoad } satisfies Preferences
  })
)
