import { it } from '@effect/vitest'
import { createProject, Id, newId, newWriter } from '@escapement/model'
import { Boolean, Data, Deferred, Duration, Effect, Fiber, Option, Scope } from 'effect'
import { KeyValueStore } from 'effect/persistence'
import { TestClock } from 'effect/testing'
import { expect } from 'vitest'
import * as Y from 'yjs'
import { inTimeOrNone, openInTimeOrNone, storageTimeout } from '../../src/services/in-time'
import { Page } from '../../src/services/page'
import type { Saving } from '../../src/services/session'
import { forgetView, ViewStores, viewStoreFor, viewStoreOf } from '../../src/services/view-store'

class Refused extends Data.TaggedError('Refused') {}

const memory = Effect.provide(Effect.service(KeyValueStore.KeyValueStore), KeyValueStore.layerMemory)

/** A page of the test's own, which the store hears go. */
const page = new EventTarget()

const onPage = Effect.provideService(Page, page)

it.effect('what answers in time is kept', () =>
  Effect.gen(function* () {
    const store = yield* memory
    expect(yield* inTimeOrNone(Effect.succeed(store), 'No store')).toEqual(Option.some(store))
  })
)

it.effect('a store the browser refuses, or that dies opening, costs the layout and not the page', () =>
  Effect.gen(function* () {
    expect(yield* inTimeOrNone(Effect.fail(new Refused()), 'Refused')).toEqual(Option.none())
    expect(yield* inTimeOrNone(Effect.die(new Error('No IndexedDB')), 'Died')).toEqual(Option.none())
  })
)

it.effect("an open that hangs where it can't be interrupted is given up on after five seconds all the same", () =>
  Effect.gen(function* () {
    const opening = yield* Effect.forkChild(inTimeOrNone(Effect.uninterruptible(Effect.never), 'Hung'))
    yield* TestClock.adjust(Duration.millis(4999))
    expect(opening.pollUnsafe()).toBeUndefined()
    yield* TestClock.adjust(Duration.millis(1))
    expect(yield* Fiber.join(opening)).toEqual(Option.none())
  })
)

it.effect(
  'what opens after the page gave up on it closes once it opens, as what opened in time closes with the page',
  () =>
    Effect.gen(function* () {
      const closed: Array<string> = []
      // As IndexedDbDatabase's: its finalizer, added first, closes only a database that opened by then.
      const opened = (name: string, when: Effect.Effect<void>) => (scope: Scope.Scope) => {
        const database = { open: false }
        const close = Effect.sync(() =>
          Boolean.match(database.open, { onTrue: () => void closed.push(name), onFalse: () => {} })
        )
        return Scope.addFinalizer(scope, close).pipe(
          Effect.andThen(when),
          Effect.andThen(
            Effect.sync(() => {
              database.open = true
            })
          )
        )
      }
      const late = yield* Deferred.make<void>()
      yield* Effect.scoped(
        Effect.gen(function* () {
          expect(yield* openInTimeOrNone(opened('in time', Effect.void), 'Late')).toEqual(Option.some(undefined))
          const opening = yield* Effect.forkChild(openInTimeOrNone(opened('late', Deferred.await(late)), 'Late'))
          yield* TestClock.adjust(storageTimeout)
          expect(yield* Fiber.join(opening)).toEqual(Option.none())
        })
      )
      // Apart from the page, which doesn't wait for what may never open.
      yield* Effect.yieldNow
      yield* Effect.yieldNow
      expect(closed).toEqual(['in time'])
      yield* Deferred.succeed(late, undefined)
      yield* Effect.yieldNow
      yield* Effect.yieldNow
      expect(closed).toEqual(['in time', 'late'])
    })
)

const project = Id('project')

/** What `store` keeps for the project under the key, as written. */
const keptAs = (store: KeyValueStore.KeyValueStore, key: string) =>
  Effect.map(store.get(`${key}:${project}`), (saved) =>
    Option.map(Option.fromUndefinedOr(saved), (json) => JSON.parse(json))
  )

/** The layout `store` keeps for the project, as written. */
const kept = (store: KeyValueStore.KeyValueStore) => keptAs(store, 'layout')

it.effect('a layout that only moved is written once the moves stop; one that opened or closed a window, at once', () =>
  Effect.gen(function* () {
    const store = yield* memory
    const view = yield* viewStoreOf(store, project, () => true)
    yield* view.saveLayout(() => ({ moved: 1 }), { now: false })
    yield* view.saveLayout(() => ({ moved: 2 }), { now: false })
    yield* TestClock.adjust(Duration.millis(299))
    expect(yield* kept(store)).toEqual(Option.none())
    yield* TestClock.adjust(Duration.millis(1))
    expect(yield* kept(store)).toEqual(Option.some({ version: 1, layout: JSON.stringify({ moved: 2 }) }))
    yield* view.saveLayout(() => ({ closed: 'mixer' }), { now: true })
    yield* Effect.yieldNow
    expect(yield* kept(store)).toEqual(Option.some({ version: 1, layout: JSON.stringify({ closed: 'mixer' }) }))
  }).pipe(onPage)
)

it.effect('the page going away writes the layout still waiting', () =>
  Effect.gen(function* () {
    const store = yield* memory
    const view = yield* viewStoreOf(store, project, () => true)
    yield* view.saveLayout(() => ({ moved: 3 }), { now: false })
    page.dispatchEvent(new Event('pagehide'))
    yield* Effect.yieldNow
    expect(yield* kept(store)).toEqual(Option.some({ version: 1, layout: JSON.stringify({ moved: 3 }) }))
    expect(Option.getOrThrow((yield* viewStoreOf(store, project, () => true)).layout)).toEqual({ moved: 3 })
  }).pipe(onPage)
)

it.effect('a store that never answers holds the page five seconds, and then the layout is none', () =>
  Effect.gen(function* () {
    const store = yield* memory
    const hung = KeyValueStore.make({ ...store, get: () => Effect.never })
    const opening = yield* Effect.forkChild(viewStoreOf(hung, project, () => true))
    yield* TestClock.adjust(storageTimeout)
    const view = yield* Fiber.join(opening)
    expect(view.layout).toEqual(Option.none())
  }).pipe(onPage)
)

it.effect("an unsaved project's layout isn't kept: its ID is the page's alone", () =>
  Effect.gen(function* () {
    const store = yield* memory
    const doc = new Y.Doc()
    const id = newId()
    createProject(doc, newWriter('test'), id)
    const unsaved = yield* viewStoreFor(Option.some(store), doc, () => 'missing')
    yield* unsaved.saveLayout(() => ({ closed: 'mixer' }), { now: true })
    yield* Effect.yieldNow
    expect(yield* store.size).toBe(0)
    const saved = yield* viewStoreFor(Option.some(store), doc, () => 'saved')
    yield* saved.saveLayout(() => ({ closed: 'mixer' }), { now: true })
    yield* Effect.yieldNow
    expect(yield* store.has(`layout:${id}`)).toBe(true)
  }).pipe(onPage)
)

it.effect("a project whose saving the browser refused keeps its layout; a deleted one's is written no more", () =>
  Effect.gen(function* () {
    const store = yield* memory
    const doc = new Y.Doc()
    const id = newId()
    createProject(doc, newWriter('test'), id)
    const saving = { now: 'saved' as Saving }
    const view = yield* viewStoreFor(Option.some(store), doc, () => saving.now)
    saving.now = 'refused'
    yield* view.saveLayout(() => ({ closed: 'mixer' }), { now: true })
    yield* Effect.yieldNow
    expect(yield* store.has(`layout:${id}`)).toBe(true)
    yield* store.remove(`layout:${id}`)
    yield* view.saveLayout(() => ({ moved: 1 }), { now: false })
    saving.now = 'erased-elsewhere'
    yield* TestClock.adjust(Duration.millis(300))
    yield* view.saveLayout(() => ({ closed: 'mixer' }), { now: true })
    yield* Effect.yieldNow
    page.dispatchEvent(new Event('pagehide'))
    yield* Effect.yieldNow
    expect(yield* store.size).toBe(0)
  }).pipe(onPage)
)

it.effect(
  "a deleted project's layout is forgotten; the others' stay, and a store that doesn't open costs nothing",
  () =>
    Effect.gen(function* () {
      const store = yield* memory
      const [deleted, kept] = [newId(), newId()]
      const key = (id: Id) => `layout:${id}`
      yield* Effect.forEach([deleted, kept], (id) => store.set(key(id), '{}'))
      yield* forgetView(deleted).pipe(Effect.provideService(ViewStores, { open: Effect.succeedSome(store) }))
      expect(yield* store.has(key(deleted))).toBe(false)
      expect(yield* store.has(key(kept))).toBe(true)
      yield* forgetView(kept).pipe(Effect.provideService(ViewStores, { open: Effect.succeedNone }))
      // A store that refuses costs nothing but the layout left.
      const refusing = KeyValueStore.make({
        ...store,
        remove: (key) =>
          Effect.fail(new KeyValueStore.KeyValueStoreError({ message: 'Refused', method: 'remove', key }))
      })
      yield* forgetView(kept).pipe(Effect.provideService(ViewStores, { open: Effect.succeedSome(refusing) }))
      expect(yield* store.has(key(kept))).toBe(true)
    })
)
