import { type Id, newId, newWriter } from '@escapement/model'
import { Array, Boolean, Context, Effect, FiberSet, Option, String } from 'effect'
import { Atom, AtomRegistry } from 'effect/reactivity'
import { Page } from './page'
import { ListError, type ListedProject, listNew, type ProjectList, ProjectLists } from './project-list'
import { ProjectStore } from './project-store'
import { manifestChannels } from './samples'
import { forgetView, ViewStores } from './view-store'

/** What the list refused the last time it was asked: a new project, a name, or deleting one. */
export type Refused = 'new' | 'rename' | 'delete'

/** The screen with the projects this browser keeps, as long as it is open. */
export interface Projects {
  /** The last opened first; none if the list didn't open or answer. */
  readonly listed: Atom.Atom<Option.Option<ReadonlyArray<ListedProject>>>
  /** While a new project is being made, or its page opening: New project makes no other then. */
  readonly making: Atom.Atom<boolean>
  readonly refused: Atom.Atom<Option.Option<Refused>>
  /** A new project, made and in the list, and then its page. */
  readonly newProject: Effect.Effect<void>
  /** The project's page. */
  readonly open: (id: Id) => Effect.Effect<void>
  /** Named so, without the spaces around; a name left empty, or as it was, changes nothing. */
  readonly rename: (id: Id, name: string) => Effect.Effect<void>
  /** Off the list, so its address leads nowhere, and then its storage and its layout erased. */
  readonly remove: (id: Id) => Effect.Effect<void>
}

export const Projects = Context.Service<Projects>('Projects')

const by = newWriter('projects')

/** How long the page waits for the new project's to take its place: one whose going was stopped stays, as it was. */
const goingTime = '1 second'

const refusal: Record<Refused, string> = {
  new: "The new project wasn't made",
  rename: "The project wasn't renamed",
  delete: "The project wasn't deleted"
}

/** All of them, or none if the list doesn't answer. */
const allOf = (list: ProjectList) =>
  list.all.pipe(
    Effect.asSome,
    Effect.catch((error) =>
      Effect.as(Effect.logWarning("The list of projects didn't answer", error.cause), Option.none())
    )
  )

/** A new project: its document made in `store`, then listed; neither, if either fails. */
const made = (store: ProjectStore, list: ProjectList) => {
  const id = newId()
  return Effect.andThen(store.make(id, by, manifestChannels), listNew(list, id)).pipe(
    // No address would lead to it. Apart: the page tells what went wrong meanwhile.
    Effect.tapError(() => Effect.forkDetach(store.erase(id))),
    Effect.as(id)
  )
}

/** The projects with the one with this ID changed by `change`. */
const changedOne = (id: Id, change: (project: ListedProject) => ListedProject) =>
  Array.map((project: ListedProject) =>
    Boolean.match(project.id === id, { onTrue: () => change(project), onFalse: () => project })
  )

/**
 * The screen of the list; `open` goes to a project's page. The list opens for each thing asked of it, so no connection
 * is held between. Back from the browser's cache, or to the tab, the screen reads the list again: another tab may have
 * changed it.
 */
export const projectsOf = Effect.fnUntraced(function* (open: (id: Id) => Effect.Effect<void>) {
  const registry = yield* AtomRegistry.AtomRegistry
  const page = yield* Page
  const lists = yield* ProjectLists
  const store = yield* ProjectStore
  const views = yield* ViewStores
  const read = Effect.scoped(
    Effect.flatMap(lists.open, Option.match({ onNone: () => Effect.succeedNone, onSome: allOf }))
  )
  /** What `use` does with the list, opened for it; failing if it doesn't open. */
  const withList = <A, E>(use: (list: ProjectList) => Effect.Effect<A, E>) =>
    Effect.scoped(
      Effect.flatMap(lists.open, (list) =>
        Option.match(list, {
          onNone: () => Effect.fail<E | ListError>(new ListError({ cause: "the list didn't open" })),
          onSome: use
        })
      )
    )
  const listed = Atom.make(yield* read).pipe(Atom.keepAlive)
  const making = Atom.make(false).pipe(Atom.keepAlive)
  const refused = Atom.make(Option.none<Refused>()).pipe(Atom.keepAlive)
  // Each read, and each change shown before its write, takes a ticket: a read shows only if nothing came after it.
  const latest = { ticket: 0 }
  const reread = Effect.suspend(() => {
    latest.ticket += 1
    const ticket = latest.ticket
    return Effect.flatMap(read, (now) =>
      Effect.sync(() =>
        Boolean.match(latest.ticket === ticket, {
          // A list that didn't answer this time keeps what it showed.
          onTrue: () => registry.update(listed, (before) => Option.orElse(now, () => before)),
          onFalse: () => {}
        })
      )
    )
  })
  // The page as it is now, with any new project in the list.
  const ready = Effect.andThen(
    reread,
    Effect.sync(() => registry.set(making, false))
  )
  /** `effect` asked of the storage; if it refuses, said so. */
  const asked = <E extends { readonly cause: unknown }>(what: Refused, effect: Effect.Effect<void, E>) =>
    Effect.sync(() => registry.set(refused, Option.none())).pipe(
      Effect.andThen(effect),
      Effect.catch((error) =>
        Effect.logError(refusal[what], error.cause).pipe(
          Effect.andThen(Effect.sync(() => registry.set(refused, Option.some(what))))
        )
      )
    )
  /** The projects shown changed at once; the list, read after `write`, tells how they are. */
  const shownAndWritten = (
    shown: (all: ReadonlyArray<ListedProject>) => ReadonlyArray<ListedProject>,
    write: Effect.Effect<void, ListError>
  ) =>
    Effect.andThen(
      Effect.sync(() => {
        latest.ticket += 1
        registry.update(listed, Option.map(shown))
      }),
      write
    )
  const run = yield* FiberSet.makeRuntime<never>()
  // From the cache, the page is as it left: going to the new project's page.
  const shown = (event: Event) =>
    Boolean.match('persisted' in event && event.persisted === true, {
      onTrue: () => void run(ready),
      onFalse: () => {}
    })
  const focused = () => void run(reread)
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      page.addEventListener('pageshow', shown)
      page.addEventListener('focus', focused)
    }),
    () =>
      Effect.sync(() => {
        page.removeEventListener('pageshow', shown)
        page.removeEventListener('focus', focused)
      })
  )
  const make = asked(
    'new',
    withList((list) => made(store, list)).pipe(
      Effect.flatMap(open),
      Effect.andThen(Effect.sleep(goingTime)),
      Effect.andThen(reread)
    )
  ).pipe(Effect.ensuring(Effect.sync(() => registry.set(making, false))))
  /** Whether the project shown with this ID has this name already. */
  const namedSo = (id: Id, name: string) =>
    Option.exists(
      registry.get(listed),
      Array.some((project) => project.id === id && project.name === name)
    )
  /** The deleted project's storage, and then its layout: once its tabs let the storage go, they write no layout. */
  const erased = (id: Id) => Effect.andThen(store.erase(id), Effect.provideService(forgetView(id), ViewStores, views))
  return {
    listed,
    making,
    refused,
    // Asked and marked at once, so a second press, as of a double click, finds it on its way.
    newProject: Effect.suspend(() =>
      Boolean.match(registry.get(making), {
        onTrue: () => Effect.void,
        onFalse: () => {
          registry.set(making, true)
          return make
        }
      })
    ),
    open,
    rename: (id, name) =>
      Option.match(
        Option.filter(Option.liftPredicate(String.trim(name), String.isNonEmpty), (name) => !namedSo(id, name)),
        {
          onNone: () => Effect.void,
          onSome: (name) =>
            asked(
              'rename',
              shownAndWritten(
                changedOne(id, (project) => ({ ...project, name })),
                withList((list) => list.change(id, { name }))
              )
            ).pipe(Effect.andThen(reread))
        }
      ),
    remove: (id) =>
      asked(
        'delete',
        shownAndWritten(
          Array.filter((project) => project.id !== id),
          withList((list) => list.remove(id))
        ).pipe(
          // Apart: the screen doesn't wait for the project's tabs to let its storage go.
          Effect.andThen(Effect.forkDetach(erased(id)))
        )
      ).pipe(Effect.andThen(reread))
  } satisfies Projects
})
