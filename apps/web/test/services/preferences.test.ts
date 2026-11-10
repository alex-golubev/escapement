import { it } from '@effect/vitest'
import { Effect, Layer, Option } from 'effect'
import { KeyValueStore } from 'effect/persistence'
import { AtomRegistry } from 'effect/reactivity'
import { expect } from 'vitest'
import { Preferences, preferencesLayer } from '../../src/services/preferences'
import { KeptViews } from '../../src/services/view-store'

/** The preferences as a page opening on `store` reads them, and what it then sees of measuring the load. */
const opened = (store: Option.Option<KeyValueStore.KeyValueStore>) =>
  Effect.gen(function* () {
    const preferences = yield* Preferences
    const registry = yield* AtomRegistry.AtomRegistry
    return { preferences, measuring: () => registry.get(preferences.measureLoad) }
  }).pipe(
    Effect.provide(preferencesLayer.pipe(Layer.provide(Layer.succeed(KeptViews, store)))),
    Effect.provideService(AtomRegistry.AtomRegistry, AtomRegistry.make())
  )

it.effect('measuring the load is on in a new browser, and switched off it stays off for the next page', () =>
  Effect.gen(function* () {
    const store = yield* Effect.service(KeyValueStore.KeyValueStore)
    const first = yield* opened(Option.some(store))
    expect(first.measuring()).toBe(true)
    yield* first.preferences.setMeasureLoad(false)
    expect(first.measuring()).toBe(false)
    expect((yield* opened(Option.some(store))).measuring()).toBe(false)
  }).pipe(Effect.provide(KeyValueStore.layerMemory))
)

it.effect('without a store, the page keeps its preferences for as long as it is open', () =>
  Effect.gen(function* () {
    const page = yield* opened(Option.none())
    yield* page.preferences.setMeasureLoad(false)
    expect(page.measuring()).toBe(false)
    expect((yield* opened(Option.none())).measuring()).toBe(true)
  })
)
