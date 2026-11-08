import { BrowserKeyValueStore, IndexedDb } from '@effect/platform-browser'
import { Context, Effect, Layer } from 'effect'
import { KeyValueStore } from 'effect/persistence'
import { openInTimeOrNone } from '../services/in-time'
import { ViewStores } from '../services/view-store'

/** In IndexedDB, beside the projects. */
export const viewStoresLayer = Layer.succeed(ViewStores, {
  open: openInTimeOrNone(
    (scope) =>
      Layer.buildWithScope(
        BrowserKeyValueStore.layerIndexedDb({ database: 'escapement-view' }).pipe(Layer.provide(IndexedDb.layerWindow)),
        scope
      ).pipe(Effect.map((built) => Context.get(built, KeyValueStore.KeyValueStore))),
    "The views' store didn't open: how projects are shown isn't kept"
  )
})
