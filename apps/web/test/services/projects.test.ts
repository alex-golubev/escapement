import { it } from '@effect/vitest'
import { Id } from '@escapement/model'
import { DateTime, Deferred, Effect, Fiber, Layer, Option, Queue, type Scope } from 'effect'
import { AtomRegistry } from 'effect/reactivity'
import { expect } from 'vitest'
import { registryOptions } from '../../src/app/core'
import { Page } from '../../src/services/page'
import { ListError, type ListedProject, type ProjectList, ProjectLists } from '../../src/services/project-list'
import { ProjectStore } from '../../src/services/project-store'
import { projectsOf } from '../../src/services/projects'
import { ViewStores } from '../../src/services/view-store'

const project = (id: string, name = 'Untitled'): ListedProject => ({
  id: Id(id),
  name,
  opened: DateTime.makeUnsafe(0)
})

type Answer = Deferred.Deferred<ReadonlyArray<ListedProject>, ListError>

/**
 * A list whose every read waits for the test to answer it, from `reads`; its writes wait for `written`, and are kept in
 * `writes`.
 */
const answeredBy = (reads: Queue.Queue<Answer>, written: Effect.Effect<void>) => {
  const writes: Array<string> = []
  const list: ProjectList = {
    all: Effect.flatMap(Deferred.make<ReadonlyArray<ListedProject>, ListError>(), (answer: Answer) =>
      Effect.andThen(Queue.offer(reads, answer), Deferred.await(answer))
    ),
    find: () => Effect.succeedNone,
    add: (project) => Effect.sync(() => void writes.push(`add ${project.id}`)),
    change: (id, fields) =>
      Effect.andThen(
        written,
        Effect.sync(() => void writes.push(`change ${id} ${JSON.stringify(fields)}`))
      ),
    remove: (id) =>
      Effect.andThen(
        written,
        Effect.sync(() => void writes.push(`remove ${id}`))
      )
  }
  return { list, writes }
}

/** The screen's service on `list`, with a page of the test's own. */
const projectsOn = (list: ProjectList, page: EventTarget) =>
  projectsOf(() => Effect.void).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(ProjectLists, { open: Effect.succeedSome(list) }),
        Layer.succeed(ProjectStore, {
          open: () => Effect.die('not opened here'),
          make: () => Effect.void,
          erase: () => Effect.void
        }),
        Layer.succeed(ViewStores, { open: Effect.succeedNone }),
        Layer.succeed(Page, page)
      )
    )
  )

/** The screen on a list that first reads `first`; then each read waits for the test, each write for `written`. */
const opened = (first: ReadonlyArray<ListedProject>, written: Effect.Effect<void> = Effect.void) =>
  Effect.gen(function* () {
    const reads = yield* Queue.unbounded<Answer>()
    const { list, writes } = answeredBy(reads, written)
    const page = new EventTarget()
    const opening = yield* Effect.forkChild(projectsOn(list, page))
    yield* Deferred.succeed(yield* Queue.take(reads), first)
    const projects = yield* Fiber.join(opening)
    const shown = Effect.map(AtomRegistry.AtomRegistry, (registry) => registry.get(projects.listed))
    return { projects, page, reads, writes, shown }
  })

const [kept, deleted] = [project('kept'), project('deleted')]

const provided = <A, E>(effect: Effect.Effect<A, E, AtomRegistry.AtomRegistry | Scope.Scope>) =>
  effect.pipe(Effect.scoped, Effect.provide(AtomRegistry.layerOptions(registryOptions)))

it.effect('a read of the list that began before a change shown since, or before a later read, shows nothing', () =>
  provided(
    Effect.gen(function* () {
      const { projects, page, reads, shown } = yield* opened([kept, deleted])
      // Back to the tab: a read begins, and a delete goes on meanwhile.
      page.dispatchEvent(new Event('focus'))
      const before = yield* Queue.take(reads)
      const removing = yield* Effect.forkChild(projects.remove(deleted.id))
      yield* Deferred.succeed(yield* Queue.take(reads), [kept])
      yield* Fiber.join(removing)
      yield* Deferred.succeed(before, [kept, deleted])
      yield* Effect.yieldNow
      expect(yield* shown).toEqual(Option.some([kept]))
    })
  )
)

it.effect('a read that began before a change shown at once, and ends before its write, leaves the change shown', () =>
  provided(
    Effect.gen(function* () {
      const written = yield* Deferred.make<void>()
      const { projects, page, reads, shown } = yield* opened([kept, deleted], Deferred.await(written))
      page.dispatchEvent(new Event('focus'))
      const before = yield* Queue.take(reads)
      const removing = yield* Effect.forkChild(projects.remove(deleted.id), { startImmediately: true })
      yield* Deferred.succeed(before, [kept, deleted])
      yield* Effect.yieldNow
      expect(yield* shown).toEqual(Option.some([kept]))
      yield* Deferred.succeed(written, undefined)
      yield* Deferred.succeed(yield* Queue.take(reads), [kept])
      yield* Fiber.join(removing)
      expect(yield* shown).toEqual(Option.some([kept]))
    })
  )
)

it.effect("a list that doesn't answer a read again keeps what the screen shows", () =>
  provided(
    Effect.gen(function* () {
      const { page, reads, shown } = yield* opened([kept])
      page.dispatchEvent(new Event('focus'))
      yield* Deferred.fail(yield* Queue.take(reads), new ListError({ cause: 'slow' }))
      yield* Effect.yieldNow
      expect(yield* shown).toEqual(Option.some([kept]))
    })
  )
)

it.effect('a name as it was, without the spaces around, writes nothing', () =>
  provided(
    Effect.gen(function* () {
      const { projects, reads, writes } = yield* opened([kept])
      yield* projects.rename(kept.id, '  Untitled ')
      expect(writes).toEqual([])
      const renaming = yield* Effect.forkChild(projects.rename(kept.id, ' Bassline'))
      yield* Deferred.succeed(yield* Queue.take(reads), [{ ...kept, name: 'Bassline' }])
      yield* Fiber.join(renaming)
      expect(writes).toEqual([`change kept ${JSON.stringify({ name: 'Bassline' })}`])
    })
  )
)
