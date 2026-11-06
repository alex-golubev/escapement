import { type Id, storedId } from '@escapement/model'
import { Context, Data, DateTime, Effect, Option, Schema, type Scope } from 'effect'

/**
 * A project as this browser's list holds it. The name is the list's, not the document's: the list reads without
 * opening each project, as the server's will.
 */
export const ListedProject = Schema.Struct({
  id: storedId,
  name: Schema.String,
  /** When a page last opened it. */
  opened: Schema.DateTimeUtcFromMillis
})

export type ListedProject = typeof ListedProject.Type

/** What a new project is called until it is renamed. */
export const newName = 'Untitled'

/** The list refused, or didn't answer in time. */
export class ListError extends Data.TaggedError('ListError')<{ readonly cause: unknown }> {}

/** What of a listed project can change: its ID names it for good. */
export type ListedChange = Partial<Omit<ListedProject, 'id'>>

/** The projects kept in this browser. Each write is done once the browser kept it: it may refuse one as it commits. */
export interface ProjectList {
  /** The last opened first. */
  readonly all: Effect.Effect<ReadonlyArray<ListedProject>, ListError>
  /** The project that an address names, if this browser keeps it. */
  readonly find: (id: string) => Effect.Effect<Option.Option<ListedProject>, ListError>
  /** A new project: its ID is new, so it takes no other's place. */
  readonly add: (project: ListedProject) => Effect.Effect<void, ListError>
  /**
   * The project with these fields changed, read and written in one go, so what changed meanwhile elsewhere stays;
   * nothing if the list has it no more, so a deleted project never comes back.
   */
  readonly change: (id: Id, fields: ListedChange) => Effect.Effect<void, ListError>
  readonly remove: (id: Id) => Effect.Effect<void, ListError>
}

/** The list, opened for what is asked of it and closed with the scope: none if it doesn't open in time. */
export interface ProjectLists {
  readonly open: Effect.Effect<Option.Option<ProjectList>, never, Scope.Scope>
}

export const ProjectLists = Context.Service<ProjectLists>('ProjectLists')

/** A new project with this ID in the list, opened now. Its document is made first: the list names only projects that
 * are. */
export const listNew = (list: ProjectList, id: Id) =>
  Effect.flatMap(DateTime.now, (opened) => list.add({ id, name: newName, opened }))

/** The list didn't open or answer: whether the address names a project here can't be told. */
export class ListUnavailable extends Data.TaggedError('ListUnavailable') {}

/** This browser keeps no project with the address's ID. */
export class NotInBrowser extends Data.TaggedError('NotInBrowser') {}

/** The project with this ID, from the list, as opened now: the list closes again. */
export const openListed = (id: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const list = yield* Effect.fromOption(yield* (yield* ProjectLists).open).pipe(
        Effect.mapError(() => new ListUnavailable())
      )
      const listed = yield* list.find(id).pipe(
        Effect.catch((error) =>
          Effect.logWarning("The list of projects didn't answer", error.cause).pipe(
            Effect.andThen(Effect.fail(new ListUnavailable()))
          )
        ),
        Effect.flatMap(Option.match({ onNone: () => Effect.fail(new NotInBrowser()), onSome: Effect.succeed }))
      )
      return { ...listed, opened: yield* DateTime.now } satisfies ListedProject
    })
  )

/**
 * In the list, when the project was last opened. Not if the list refuses the write: it costs the order of the list,
 * not the page.
 */
export const markOpened = ({ id, opened }: ListedProject) =>
  Effect.scoped(
    Effect.flatMap(
      Effect.flatMap(ProjectLists, (lists) => lists.open),
      Option.match({
        onNone: () => Effect.void,
        onSome: (list) =>
          list
            .change(id, { opened })
            .pipe(Effect.catch((error) => Effect.logWarning("The project wasn't marked as opened", error.cause)))
      })
    )
  )
