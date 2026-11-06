import { type IndexedDb, IndexedDbDatabase, IndexedDbTable, IndexedDbVersion } from '@effect/platform-browser'
import { Array, Cause, DateTime, Effect, Layer, Option, Order } from 'effect'
import { Reactivity } from 'effect/reactivity'
import { inTimeOrRefused, openInTimeOrNone } from '../services/in-time'
import { ListError, ListedProject, type ProjectList, ProjectLists } from '../services/project-list'

const projects = IndexedDbTable.make({ name: 'projects', schema: ListedProject, keyPath: 'id' })

const listSchema = IndexedDbDatabase.make(IndexedDbVersion.make(projects), (query) =>
  Effect.asVoid(query.createObjectStore('projects'))
)

/** Where this browser keeps its list. */
export const listName = 'escapement-projects'

const lastOpenedFirst = Order.flip(Order.mapInput(DateTime.Order, ({ opened }: ListedProject) => opened))

const inTime = <A, E>(effect: Effect.Effect<A, E>) => inTimeOrRefused(effect, (cause) => new ListError({ cause }))

/**
 * The list in the database the scope holds open, in `storage`: none if it doesn't open in time, or the browser has no
 * IndexedDB to open it in.
 */
export const openProjectList = Effect.fnUntraced(function* (storage: Layer.Layer<IndexedDb.IndexedDb>) {
  const opened = yield* openInTimeOrNone(
    (scope) =>
      Layer.buildWithScope(
        listSchema.layer(listName).pipe(Layer.provide(Reactivity.layer), Layer.provide(storage)),
        scope
      ).pipe(Effect.flatMap((built) => Effect.provideContext(listSchema.getQueryBuilder, built))),
    "The list of projects didn't open"
  )
  return Option.map(opened, (query): ProjectList => {
    const table = query.from('projects')
    // In a transaction of its own: done once it commits, which the browser may refuse after it answered the write.
    const committed = query.withTransaction({ tables: ['projects'], mode: 'readwrite' })
    const find = (id: string) =>
      table
        .select()
        .equals(id)
        .first()
        .pipe(
          Effect.asSome,
          Effect.catchIf(Cause.isNoSuchElementError, () => Effect.succeedNone)
        )
    return {
      all: inTime(Effect.map(table.select(), Array.sort(lastOpenedFirst))),
      find: (id) => inTime(find(id)),
      add: (project) => inTime(committed(Effect.asVoid(table.upsert(project)))),
      change: (id, fields) =>
        inTime(
          committed(
            Effect.flatMap(find(id), (found) =>
              Option.match(found, {
                onNone: () => Effect.void,
                onSome: (project) => Effect.asVoid(table.upsert({ ...project, ...fields }))
              })
            )
          )
        ),
      remove: (id) => inTime(committed(table.delete().equals(id)))
    }
  })
})

/** The list in IndexedDB, in `storage`'s. */
export const projectListsLayer = (storage: Layer.Layer<IndexedDb.IndexedDb>) =>
  Layer.succeed(ProjectLists, { open: openProjectList(storage) })
