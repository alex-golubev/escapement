import 'fake-indexeddb/auto'
import { describe, it } from '@effect/vitest'
import { defaultTempo } from '@escapement/engine-description'
import { newId, newWriter, type Project, readProject, readProjectId, setTempo } from '@escapement/model'
import { Effect, Fiber, Option } from 'effect'
import { SecureRandom } from 'effect/crypto'
import { TestClock } from 'effect/testing'
import { afterEach, expect } from 'vitest'
import { clearDocument } from 'y-indexeddb'
import * as Y from 'yjs'
import { makeProject, openProjectStorage, refusalOf } from '../../src/browser/project-store'
import { storageTimeout } from '../../src/services/in-time'
import { type Loaded, NotMade, type ProjectStorage } from '../../src/services/project-store'

const by = newWriter('test')

/** The ID a page opens the project with, as its address names it. */
const id = newId()

/** Bytes no update starts with: Yjs throws on them. */
const broken = new Uint8Array([1, 2, 3])

/** A storage name of the test's own. */
const freshName = Effect.flatMap(SecureRandom.SecureRandom, (random) => random.uuidV4()).pipe(
  Effect.provide(SecureRandom.layerWebCrypto)
)

interface Opened {
  readonly loaded: Loaded
  readonly project: Project
}

/** The project opened and closed again, edited meanwhile. */
const opened = (name: string, edit: (doc: Y.Doc) => void = () => {}) =>
  Effect.scoped(
    Effect.map(openProjectStorage(name, by, id), ({ doc, loaded }) => {
      edit(doc)
      return { loaded, project: readProject(doc).value } satisfies Opened
    })
  )

/** Storage of the test's own, with a new project made in it, as by New project. */
const made = Effect.tap(freshName, (name) => makeProject(name, by, id).pipe(Effect.orDie))

const request = <A>(pending: IDBRequest<A>) =>
  Effect.callback<A, DOMException | null>((resume) => {
    pending.onsuccess = () => resume(Effect.succeed(pending.result))
    pending.onerror = () => resume(Effect.fail(pending.error))
  }).pipe(Effect.orDie)

/** A connection of the test's own, closed with the scope. */
const connection = (name: string) =>
  Effect.acquireRelease(request(indexedDB.open(name)), (db) => Effect.sync(() => db.close()))

/** y-indexeddb keeps each change as a record of its `updates` store. */
const withUpdates = <A>(name: string, use: (updates: IDBObjectStore) => IDBRequest<A>) =>
  Effect.scoped(
    Effect.flatMap(connection(name), (db) =>
      request(use(db.transaction('updates', 'readwrite').objectStore('updates')))
    )
  )

const records = (name: string) => withUpdates(name, (updates) => updates.getAll() as IDBRequest<Array<Uint8Array>>)

const isBroken = (update: Uint8Array) =>
  update.length === broken.length && update.every((byte, i) => byte === broken[i])

/** y-indexeddb loses what Yjs throws on a record as an unhandled rejection: its load is over then. Listened for at once. */
const unhandledRejection = Effect.forkChild(
  Effect.callback<unknown>((resume) => {
    const rejected = (reason: unknown) => resume(Effect.succeed(reason))
    process.once('unhandledRejection', rejected)
    return Effect.sync(() => process.off('unhandledRejection', rejected))
  }),
  { startImmediately: true }
)

/** What the records hold, past the broken one. */
const projectOf = (updates: ReadonlyArray<Uint8Array>) => {
  const doc = new Y.Doc()
  updates.filter((update) => !isBroken(update)).forEach((update) => Y.applyUpdate(doc, update))
  return readProject(doc).value
}

const add = IDBObjectStore.prototype.add

// Also if a test failed before y-indexeddb's next write.
afterEach(() => {
  IDBObjectStore.prototype.add = add
})

/** y-indexeddb's next write goes with one that fails, as a write the browser refuses: its transaction aborts. */
const refuseNextWrite = () => {
  IDBObjectStore.prototype.add = function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
    IDBObjectStore.prototype.add = add
    const written = add.call(this, value, key)
    add.call(this, value, 'twice')
    add.call(this, value, 'twice')
    return written
  }
}

/** Opens the project and saves a tempo, `refuse` has a write refused, then one more: why saving stopped, the tempo. */
const refusedAfter = (name: string, refuse: (storage: ProjectStorage) => Effect.Effect<void>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const storage = yield* openProjectStorage(name, by, id)
      setTempo(storage.doc, by, 150)
      yield* refuse(storage)
      const stopped = yield* storage.stopped
      setTempo(storage.doc, by, 170)
      return { stopped, tempo: readProject(storage.doc).value.tempo }
    })
  )

describe('project storage', () => {
  it.effect('a new project is made with the ID given, and opens as saved, empty', () =>
    Effect.gen(function* () {
      const name = yield* made
      const { loaded, project } = yield* opened(name)
      expect(loaded).toBe('saved')
      expect(project.tracks).toEqual([])
      expect(project.tempo).toBe(defaultTempo)
      const ids = yield* Effect.scoped(Effect.map(openProjectStorage(name, by, id), ({ doc }) => readProjectId(doc)))
      expect(ids).toEqual(Option.some(id))
    })
  )

  it.effect('a saved project opens again as it was, with the changes made to it', () =>
    Effect.gen(function* () {
      const name = yield* made
      const first = yield* opened(name, (doc) => setTempo(doc, by, 150))
      const again = yield* opened(name)
      expect(first.loaded).toBe('saved')
      expect(again).toEqual({ loaded: 'saved', project: first.project })
      expect(again.project.tempo).toBe(150)
    })
  )

  it.effect(
    "the page never makes the project it opens: one missing is new, with an ID of its own, and isn't saved",
    () =>
      Effect.gen(function* () {
        const name = yield* freshName
        const { doc, loaded } = yield* Effect.scoped(openProjectStorage(name, by, id))
        expect(loaded).toBe('missing')
        expect(readProject(doc).value.tracks).toEqual([])
        expect(Option.isSome(readProjectId(doc))).toBe(true)
        expect(readProjectId(doc)).not.toEqual(Option.some(id))
        // No project was written in its place.
        expect((yield* opened(name)).loaded).toBe('missing')
      })
  )

  it.effect('storage that holds another project is missing the one the page opens', () =>
    Effect.gen(function* () {
      const name = yield* freshName
      yield* makeProject(name, by, newId())
      expect((yield* opened(name)).loaded).toBe('missing')
    })
  )

  it.effect('a new project the browser refuses as it commits is not made, though the write answered', () =>
    Effect.gen(function* () {
      const name = yield* freshName
      const failed = yield* unhandledRejection
      IDBObjectStore.prototype.add = function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
        IDBObjectStore.prototype.add = add
        const written = add.call(this, value, key)
        written.addEventListener('success', () => this.transaction.abort())
        return written
      }
      expect(yield* Effect.flip(makeProject(name, by, id))).toBeInstanceOf(NotMade)
      // y-indexeddb goes on reading in the transaction aborted under it, and loses the error event it rejects with.
      expect(yield* Fiber.join(failed)).toHaveProperty('type', 'error')
      expect((yield* opened(name)).loaded).toBe('missing')
    })
  )

  it.effect("a new project storage throws on isn't made", () =>
    Effect.gen(function* () {
      const name = yield* freshName
      IDBObjectStore.prototype.add = () => {
        throw new DOMException('', 'InvalidStateError')
      }
      const making = yield* Effect.forkChild(Effect.flip(makeProject(name, by, id)), {
        startImmediately: true
      })
      yield* TestClock.adjust(storageTimeout)
      expect(yield* Fiber.join(making)).toBeInstanceOf(NotMade)
    })
  )

  it.effect(
    'a project that does not load is new, with an ID of its own, and not saved; the saved one stays as it was',
    () =>
      Effect.gen(function* () {
        const name = yield* made
        const first = yield* opened(name)
        yield* withUpdates(name, (updates) => updates.add(broken))
        const failed = yield* unhandledRejection
        const opening = yield* Effect.forkChild(openProjectStorage(name, by, id), { startImmediately: true })
        expect(yield* Fiber.join(failed)).toBeInstanceOf(Error)
        yield* TestClock.adjust(storageTimeout)
        const { doc, loaded } = yield* Fiber.join(opening)
        setTempo(doc, by, 150)
        const second = { loaded, project: readProject(doc).value }
        expect(second.loaded).toBe('not-loaded')
        expect(Option.isSome(readProjectId(doc))).toBe(true)
        expect(readProjectId(doc)).not.toEqual(Option.some(id))
        expect(second.project.tracks).toEqual([])
        const kept = yield* records(name)
        expect(kept).toContainEqual(broken)
        expect(projectOf(kept)).toEqual(first.project)
      })
  )

  it.effect('a project erased elsewhere stops saving here, and its edits go on', () =>
    Effect.gen(function* () {
      const name = yield* made
      const changes = yield* Effect.scoped(
        Effect.gen(function* () {
          const here = yield* openProjectStorage(name, by, id)
          yield* Effect.promise(() => clearDocument(name))
          expect(yield* here.stopped).toBe('erased-elsewhere')
          const changes: Array<Uint8Array> = []
          here.doc.on('update', (update: Uint8Array) => changes.push(update))
          setTempo(here.doc, by, 150)
          setTempo(here.doc, by, 160)
          return changes.length
        })
      )
      expect(changes).toBe(2)
      expect((yield* opened(name)).loaded).toBe('missing')
    })
  )

  it.effect('a refused write stops saving, and the edits go on: what is saved is the project before it', () =>
    Effect.gen(function* () {
      const name = yield* made
      const refused = yield* refusedAfter(name, (storage) =>
        Effect.sync(() => {
          refuseNextWrite()
          setTempo(storage.doc, by, 160)
        })
      )
      expect(refused).toEqual({ stopped: 'refused', tempo: 170 })
      const next = yield* opened(name)
      expect([next.loaded, next.project.tempo]).toEqual(['saved', 150])
    })
  )

  it.effect('Break saving stops saving the same way, and does nothing once saving stopped, however it did', () =>
    Effect.gen(function* () {
      const name = yield* made
      expect(yield* refusedAfter(name, (storage) => storage.breakSaving)).toEqual({ stopped: 'refused', tempo: 170 })
      expect((yield* opened(name)).project.tempo).toBe(150)
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { breakSaving, stopped } = yield* openProjectStorage(name, by, id)
          yield* Effect.promise(() => clearDocument(name))
          expect(yield* stopped).toBe('erased-elsewhere')
          yield* breakSaving
        })
      )
    })
  )

  it('a write refused for lack of space says so, any other is refused; one aborted as storage closes, neither', () => {
    const refusal = (name: string) => refusalOf(new DOMException('', name))
    expect([refusal('QuotaExceededError'), refusal('ConstraintError'), refusalOf(null)]).toEqual([
      Option.some('out-of-space'),
      Option.some('refused'),
      Option.some('refused')
    ])
    // Its `close` says why.
    expect(refusal('AbortError')).toEqual(Option.none())
  })
})
