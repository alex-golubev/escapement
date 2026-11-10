import type { LoadClockError } from '@escapement/engine'
import { Context, type Effect } from 'effect'
import type { Atom } from 'effect/reactivity'

/** What timing the engine's blocks needs of the computer: its cores, a thread for the clock, and the page in sight. */
export interface LoadClocks {
  /** Logical cores, as the browser tells them. */
  readonly cores: number
  /** The clock's thread on `clock`, until it fails or is interrupted. */
  readonly thread: (clock: SharedArrayBuffer) => Effect.Effect<never, LoadClockError>
  /** Whether the page is in sight: hidden, nothing draws what is measured. */
  readonly seen: Atom.Atom<boolean>
}

export const LoadClocks = Context.Service<LoadClocks>('LoadClocks')
