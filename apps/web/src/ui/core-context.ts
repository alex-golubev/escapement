import { type Effect, Option } from 'effect'
import type { AtomRegistry } from 'effect/reactivity'
import { createContext } from 'preact'
import { useContext } from 'preact/hooks'
import type { DomainOps } from '../services/domain-ops'
import type { EngineHost } from '../services/engine-host'
import type { ProjectView } from '../services/project-view'
import type { ProjectSession } from '../services/session'
import type { TabSync } from '../services/tab-sync'
import type { Turns } from '../services/turns'

/** What the components take from the core. */
export interface Core {
  readonly registry: AtomRegistry.AtomRegistry
  readonly session: ProjectSession
  readonly ops: DomainOps
  readonly turns: Turns
  readonly host: EngineHost
  readonly tabs: TabSync
  readonly view: ProjectView
  /** Runs an action in the core; a failure is logged. */
  readonly run: (effect: Effect.Effect<void>) => void
}

export const CoreContext = createContext<Core | undefined>(undefined)

export const useCore = (): Core =>
  Option.getOrThrowWith(
    Option.fromUndefinedOr(useContext(CoreContext)),
    () => new Error('A component that needs the core is drawn outside it')
  )
