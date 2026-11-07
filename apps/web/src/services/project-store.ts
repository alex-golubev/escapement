import type { Id, Writer } from '@escapement/model'
import { Context, Data, type Effect, type Scope } from 'effect'
import type * as Y from 'yjs'

/** Each project's storage is named from it, and so are the channels its tabs keep in step on. */
export const storageName = 'escapement-project'

/**
 * Why saving stopped under the page: the storage was erased or closed elsewhere, or the browser refused a write, for
 * lack of space or otherwise. What is saved is the project before the refused write, give or take changes already on
 * their way, which a reload may not show: they build on it.
 */
export type Stopped = 'erased-elsewhere' | 'out-of-space' | 'refused'

/**
 * What the page found as it opened the project: the project, saved; or storage that didn't load, or holds no project
 * with its ID, as erased, or never kept. Then the page's project is new and isn't saved: the storage keeps what it held,
 * and gains at most the empty change y-indexeddb writes as it opens.
 */
export type Loaded = 'saved' | 'not-loaded' | 'missing'

/** The project the page edits, kept in this browser. */
export interface ProjectStorage {
  readonly doc: Y.Doc
  readonly loaded: Loaded
  /** Done once saving stopped under the page, for good. */
  readonly stopped: Effect.Effect<Stopped>
  /** A write aborted as one the browser refuses, so the page's recovery can be checked: nothing is written. */
  readonly breakSaving: Effect.Effect<void>
}

/** The new project wasn't kept: the browser refused it, or didn't answer in time. */
export class NotMade extends Data.TaggedError('NotMade')<{ readonly cause: unknown }> {}

/** Where this browser keeps its projects, each by its ID. */
export interface ProjectStore {
  /**
   * The project with this ID, saving each change while the scope is open. If the storage doesn't load, or holds no such
   * project, a new one written by `by`, with an ID of its own: it is another project, and must never meet the saved
   * one's tabs. A page never makes the project it opens: two that found nothing would make two projects with one ID,
   * and their tabs would merge them.
   */
  readonly open: (id: Id, by: Writer) => Effect.Effect<ProjectStorage, never, Scope.Scope>
  /** A new project with this ID, written by `by`, read back before it counts. */
  readonly make: (id: Id, by: Writer) => Effect.Effect<void, NotMade>
  /** The project's storage gone, as far as the browser lets it. */
  readonly erase: (id: Id) => Effect.Effect<void>
}

export const ProjectStore = Context.Service<ProjectStore>('ProjectStore')
