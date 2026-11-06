import 'fake-indexeddb/auto'
import { IndexedDb } from '@effect/platform-browser'
import { Effect, Layer } from 'effect'
import { listName } from '../src/browser/project-list'

/** A browser with no IndexedDB, as the page's layer of it dies then. */
export const noIndexedDb = Layer.effect(IndexedDb.IndexedDb, Effect.die(new Error('window.indexedDB is not available')))

/** IndexedDB as the page has it, from the browser's globals: fake-indexeddb's in tests. */
export const browserIndexedDb = Layer.succeed(
  IndexedDb.IndexedDb,
  IndexedDb.make({ indexedDB: globalThis.indexedDB, IDBKeyRange: globalThis.IDBKeyRange })
)

const deleted = (name: string) =>
  Effect.callback<void>((resume) => {
    const request = indexedDB.deleteDatabase(name)
    request.onsuccess = () => resume(Effect.void)
    request.onerror = () => resume(Effect.die(request.error))
  })

/** The list gone: its name is the app's own, shared by the tests of a file. */
export const freshBrowser = deleted(listName)

/** The browser's own ways to write and delete a record, which a test may change to have them refused. */
export const put = IDBObjectStore.prototype.put
const remove = IDBObjectStore.prototype.delete

/** Writes as the browser makes them again: after each test, also one that failed before its write. */
export const ownWrites = () => {
  IDBObjectStore.prototype.put = put
  IDBObjectStore.prototype.delete = remove
}
