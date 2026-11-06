import { IndexedDb } from '@effect/platform-browser'
import { describe, it } from '@effect/vitest'
import { Id, newId } from '@escapement/model'
import { DateTime, Duration, Effect, Fiber, Layer, Option } from 'effect'
import { TestClock } from 'effect/testing'
import { afterEach, expect } from 'vitest'
import { openProjectList, projectListsLayer } from '../../src/browser/project-list'
import { storageTimeout } from '../../src/services/in-time'
import {
  ListError,
  ListUnavailable,
  listNew,
  markOpened,
  NotInBrowser,
  newName,
  openListed,
  type ProjectList
} from '../../src/services/project-list'
import { browserIndexedDb, freshBrowser, noIndexedDb, ownWrites, put } from '../indexed-db'

/** The list, opened in a browser that has none yet. */
const freshList = Effect.andThen(freshBrowser, openProjectList(browserIndexedDb)).pipe(
  Effect.flatMap(Effect.fromOption),
  Effect.orDie
)

/** With the list in `storage`'s IndexedDB. */
const inList = (storage: Layer.Layer<IndexedDb.IndexedDb>) => Effect.provide(projectListsLayer(storage))

/** A new project listed, as its ID. */
const listed = (list: ProjectList) => {
  const id = newId()
  return Effect.as(listNew(list, id), id)
}

const listedAt = (list: ProjectList, minutes: number) =>
  Effect.andThen(TestClock.setTime(Duration.toMillis(Duration.minutes(minutes))), listed(list))

/** What `use` does with the list, opened for it, as another page of the browser would. */
const inOpenList = <A>(use: (list: ProjectList) => Effect.Effect<A, ListError>) =>
  Effect.scoped(Effect.flatMap(Effect.flatMap(openProjectList(browserIndexedDb), Effect.fromOption), use)).pipe(
    Effect.orDie
  )

/** What the list holds for `id` now. */
const found = (id: string) => inOpenList((list) => list.find(id))

/** IndexedDB whose databases never open. */
const hanging = Layer.succeed(
  IndexedDb.IndexedDb,
  IndexedDb.make({
    indexedDB: { ...globalThis.indexedDB, open: () => ({}) as IDBOpenDBRequest } as IDBFactory,
    IDBKeyRange: globalThis.IDBKeyRange
  })
)

afterEach(ownWrites)

/** The next write answers, and then its transaction aborts, as a write the browser refuses as it commits. */
const refuseNextCommit = () => {
  IDBObjectStore.prototype.put = function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
    IDBObjectStore.prototype.put = put
    const written = put.call(this, value, key)
    written.addEventListener('success', () => this.transaction.abort())
    return written
  }
}

describe('the list of projects', () => {
  it.effect('a new project is listed, as Untitled, opened now; the last opened come first', () =>
    Effect.gen(function* () {
      const list = yield* freshList
      expect(yield* list.all).toEqual([])
      const first = yield* listedAt(list, 1)
      const second = yield* listedAt(list, 2)
      expect(first).not.toEqual(second)
      const all = yield* list.all
      expect(all.map(({ id }) => id)).toEqual([second, first])
      expect(all.map(({ name }) => name)).toEqual([newName, newName])
      expect(all.map(({ opened }) => DateTime.toEpochMillis(opened))).toEqual([120_000, 60_000])
      yield* list.change(first, { opened: DateTime.makeUnsafe(180_000) })
      expect((yield* list.all).map(({ id }) => id)).toEqual([first, second])
    }).pipe(Effect.scoped)
  )

  it.effect('a new project the browser refuses as it commits is not made, though the write answered', () =>
    Effect.gen(function* () {
      const list = yield* freshList
      refuseNextCommit()
      expect(yield* Effect.flip(listed(list))).toBeInstanceOf(ListError)
      expect(yield* list.all).toEqual([])
    }).pipe(Effect.scoped)
  )

  it.effect('a write the browser throws on is the list refusing it', () =>
    Effect.gen(function* () {
      const list = yield* freshList
      IDBObjectStore.prototype.put = () => {
        throw new DOMException('', 'InvalidStateError')
      }
      expect(yield* Effect.flip(listed(list))).toBeInstanceOf(ListError)
    }).pipe(Effect.scoped)
  )

  it.effect('a project is found by the ID its address names; one the list has not, is not', () =>
    Effect.gen(function* () {
      const list = yield* freshList
      const id = yield* listed(list)
      expect(Option.map(yield* list.find(id), (project) => project.id)).toEqual(Option.some(id))
      expect(yield* list.find('not-a-project')).toEqual(Option.none())
    }).pipe(Effect.scoped)
  )

  it.effect('a change writes only the fields it names; a project the list has not gains no row', () =>
    Effect.gen(function* () {
      const list = yield* freshList
      const id = yield* listedAt(list, 1)
      yield* list.change(id, { name: 'Bassline' })
      yield* list.change(id, { opened: DateTime.makeUnsafe(120_000) })
      expect(yield* list.find(id)).toEqual(Option.some({ id, name: 'Bassline', opened: DateTime.makeUnsafe(120_000) }))
      yield* list.change(Id('not-a-project'), { name: 'Ghost' })
      expect((yield* list.all).map(({ id }) => id)).toEqual([id])
    }).pipe(Effect.scoped)
  )

  it.effect('a change the browser refuses as it commits is the list refusing it, and changes nothing', () =>
    Effect.gen(function* () {
      const list = yield* freshList
      const id = yield* listed(list)
      refuseNextCommit()
      expect(yield* Effect.flip(list.change(id, { name: 'Bassline' }))).toBeInstanceOf(ListError)
      expect(Option.map(yield* list.find(id), ({ name }) => name)).toEqual(Option.some(newName))
    }).pipe(Effect.scoped)
  )

  it.effect('a removed project is off the list; the others stay', () =>
    Effect.gen(function* () {
      const list = yield* freshList
      const kept = yield* listedAt(list, 1)
      const removed = yield* listedAt(list, 2)
      yield* list.remove(removed)
      expect(yield* list.find(removed)).toEqual(Option.none())
      expect((yield* list.all).map(({ id }) => id)).toEqual([kept])
    }).pipe(Effect.scoped)
  )

  it.effect(
    'marked as opened after a rename elsewhere, the project keeps the new name; after a delete, it stays off',
    () =>
      Effect.gen(function* () {
        const id = yield* Effect.scoped(Effect.flatMap(freshList, (list) => listedAt(list, 1)))
        const opened = yield* openListed(id).pipe(inList(browserIndexedDb))
        yield* inOpenList((list) => list.change(id, { name: 'Bassline' }))
        yield* markOpened(opened).pipe(inList(browserIndexedDb))
        expect(yield* found(id)).toEqual(Option.some({ ...opened, name: 'Bassline' }))
        yield* inOpenList((list) => list.remove(id))
        yield* markOpened(opened).pipe(inList(browserIndexedDb))
        expect(yield* found(id)).toEqual(Option.none())
        yield* freshBrowser
      })
  )

  it.effect('the page opens a listed project as opened now, marked so apart; the list closes each time', () =>
    Effect.gen(function* () {
      const id = yield* Effect.scoped(Effect.flatMap(freshList, (list) => listedAt(list, 1)))
      yield* TestClock.setTime(Duration.toMillis(Duration.minutes(5)))
      const opened = yield* openListed(id).pipe(inList(browserIndexedDb))
      expect(opened).toEqual({ id, name: newName, opened: DateTime.makeUnsafe(300_000) })
      expect(Option.map(yield* found(id), ({ opened }) => DateTime.toEpochMillis(opened))).toEqual(Option.some(60_000))
      yield* markOpened(opened).pipe(inList(browserIndexedDb))
      expect(yield* found(id)).toEqual(Option.some(opened))
      // A connection left open would hold the erasing up.
      yield* freshBrowser
    })
  )

  it.effect('an address of a project the list has not is not in this browser', () =>
    Effect.gen(function* () {
      yield* Effect.scoped(Effect.flatMap(freshList, listed))
      expect(yield* Effect.flip(openListed(Id('not-a-project')).pipe(inList(browserIndexedDb)))).toEqual(
        new NotInBrowser()
      )
    })
  )

  it.effect("a list that doesn't open in time is unavailable: whether the project is here can't be told", () =>
    Effect.gen(function* () {
      const opening = yield* Effect.forkChild(Effect.flip(openListed('any').pipe(inList(hanging))), {
        startImmediately: true
      })
      yield* TestClock.adjust(storageTimeout)
      expect(yield* Fiber.join(opening)).toEqual(new ListUnavailable())
    })
  )

  it.effect('a browser with no IndexedDB has no list: the project is unavailable, and marking it does nothing', () =>
    Effect.gen(function* () {
      expect(yield* Effect.flip(openListed('any').pipe(inList(noIndexedDb)))).toEqual(new ListUnavailable())
      yield* markOpened({ id: Id('any'), name: newName, opened: DateTime.makeUnsafe(0) }).pipe(
        Effect.provide(projectListsLayer(noIndexedDb))
      )
    })
  )
})
