import { Effect } from 'effect'
import type * as Y from 'yjs'
import type { ProjectStorage } from '../src/services/project-store'

/** Storage that keeps the project in `doc` as saved and never stops: for tests of anything but storage. */
export const savedIn = (doc: Y.Doc): ProjectStorage => ({
  doc,
  loaded: 'saved',
  stopped: Effect.never,
  breakSaving: Effect.void
})
