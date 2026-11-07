import { createProject, type Id, newId, readProjectId, type Writer } from '@escapement/model'
import { Boolean, Deferred, Effect, FiberSet, Layer, Match, Option } from 'effect'
import { clearDocument, IndexeddbPersistence } from 'y-indexeddb'
import * as Y from 'yjs'
import { inTimeOrRefused, storageTimeout } from '../services/in-time'
import {
  type Loaded,
  NotMade,
  type ProjectStorage,
  ProjectStore,
  type Stopped,
  storageName
} from '../services/project-store'

/** Where this browser keeps the project with this ID. */
export const storageOf = (id: Id) => `${storageName}/${id}`

/** Stops saving; done once the storage is closed. One that never opened has already said why in the console. */
const close = (persistence: IndexeddbPersistence) => Effect.ignore(Effect.tryPromise(() => persistence.destroy()))

/** Begun at once, so nothing more is written, and not waited for: storage that never opened never closes either. */
const closeApart = (persistence: IndexeddbPersistence) =>
  Effect.asVoid(Effect.forkDetach(close(persistence), { startImmediately: true }))

/** Saving `doc` under `name` as it changes, while the scope is open. */
const persistenceOf = (name: string, doc: Y.Doc) =>
  Effect.acquireRelease(
    Effect.sync(() => new IndexeddbPersistence(name, doc)),
    closeApart
  )

/** Where y-indexeddb keeps each change. */
const updatesStore = 'updates'

/**
 * What a write's aborted transaction says, by its error: y-indexeddb aborts none itself, so it was refused. Not with
 * `AbortError`, which storage closed under the page aborts its writes with, and then says so with `close`.
 */
export const refusalOf = (error: DOMException | null): Option.Option<Stopped> =>
  Match.value(error?.name).pipe(
    Match.when('AbortError', () => Option.none<Stopped>()),
    Match.when('QuotaExceededError', () => Option.some<Stopped>('out-of-space')),
    Match.orElse(() => Option.some<Stopped>('refused'))
  )

/** The error a write's transaction aborted with: it tells the database it was opened on. */
const abortedWith = ({ target }: Event) =>
  Option.flatMapNullishOr(
    Option.liftPredicate(target, (target): target is IDBTransaction => target instanceof IDBTransaction),
    (transaction) => transaction.error
  )

/** A new project with this ID, written by `by`, in a document of its own. */
const madeIn = (by: Writer, id: Id) => {
  const doc = new Y.Doc()
  createProject(doc, by, id)
  return doc
}

/** As `ProjectStore.open`, with the project saved under `name`. */
export const openProjectStorage = Effect.fnUntraced(function* (name: string, by: Writer, id: Id) {
  const persistence = yield* persistenceOf(name, new Y.Doc())
  const synced = Option.isSome(
    yield* Effect.promise(() => persistence.whenSynced).pipe(Effect.timeoutOption(storageTimeout))
  )
  const loaded = Boolean.match(synced, {
    onTrue: (): Loaded =>
      Boolean.match(Option.contains(readProjectId(persistence.doc), id), {
        onTrue: () => 'saved',
        onFalse: () => 'missing'
      }),
    onFalse: (): Loaded => 'not-loaded'
  })
  const saved = loaded === 'saved'
  const stopped = yield* Deferred.make<Stopped>()
  // What the storage's listeners do happens at once.
  const run = yield* FiberSet.makeRuntime<never>()
  // y-indexeddb would go on writing to the closed storage, throwing inside each change of the document; after a
  // refused write, the changes it saved would build on one it didn't.
  const stop = (why: Stopped) => Effect.andThen(closeApart(persistence), Deferred.succeed(stopped, why))
  const writeAborted = (event: Event) => {
    const error = abortedWith(event)
    return Option.match(
      Option.filter(refusalOf(Option.getOrNull(error)), () => !persistence._destroyed),
      {
        onNone: () => Effect.void,
        onSome: (refusal) =>
          Effect.logError(
            'The browser refused to save the project',
            Option.getOrElse(error, () => 'its write was aborted')
          ).pipe(Effect.andThen(stop(refusal)))
      }
    )
  }
  yield* Option.match(
    Option.filter(Option.fromNullishOr(persistence.db), () => saved),
    {
      onNone: () => closeApart(persistence),
      onSome: (db) =>
        Effect.sync(() => {
          db.addEventListener('versionchange', () => run(stop('erased-elsewhere')))
          db.addEventListener('close', () => run(stop('erased-elsewhere')))
          db.addEventListener('abort', (event) => run(writeAborted(event)))
        })
    }
  )
  // Not in the storage's: y-indexeddb tells only of a load that worked, and one that didn't may have left part of a
  // record in its document.
  const doc = yield* Effect.sync(() =>
    Boolean.match(saved, { onTrue: () => persistence.doc, onFalse: () => madeIn(by, newId()) })
  )
  return {
    doc,
    loaded,
    stopped: Deferred.await(stopped),
    // Whichever way it closed, nothing.
    breakSaving: Effect.suspend(() =>
      Option.match(
        Option.filter(Option.fromNullishOr(persistence.db), () => !persistence._destroyed),
        {
          onNone: () => Effect.void,
          onSome: (db) => Effect.sync(() => db.transaction(updatesStore, 'readwrite').abort())
        }
      )
    )
  } satisfies ProjectStorage
})

/** Saved under `name`, in `doc`, once loaded, while the scope is open. */
const persisted = (name: string, doc: Y.Doc) =>
  Effect.tap(persistenceOf(name, doc), (persistence) => Effect.promise(() => persistence.whenSynced))

/**
 * As `ProjectStore.make`, with the project saved under `name`: read back from there before it counts, as the browser
 * may refuse the write once it has answered it, as it commits.
 */
export const makeProject = (name: string, by: Writer, id: Id) =>
  inTimeOrRefused(
    Effect.gen(function* () {
      // y-indexeddb saves what the document already holds as it opens.
      yield* Effect.scoped(persisted(name, yield* Effect.sync(() => madeIn(by, id))))
      return yield* Effect.scoped(Effect.map(persisted(name, new Y.Doc()), ({ doc }) => readProjectId(doc)))
    }),
    (cause) => new NotMade({ cause })
  ).pipe(
    Effect.filterOrFail(
      (back) => Option.contains(back, id),
      () => new NotMade({ cause: "the browser didn't keep the new project" })
    ),
    Effect.asVoid
  )

/** The storage under `name` gone, and the project in it. */
export const erase = (name: string) => Effect.tryPromise(() => clearDocument(name))

/** In IndexedDB, through y-indexeddb: a database for each project. */
export const projectStoreLayer = Layer.succeed(ProjectStore, {
  open: (id, by) => openProjectStorage(storageOf(id), by, id),
  make: (id, by) => makeProject(storageOf(id), by, id),
  erase: (id) =>
    erase(storageOf(id)).pipe(Effect.catch((error) => Effect.logWarning("The project's storage wasn't erased", error)))
})
