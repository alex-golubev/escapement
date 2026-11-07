import type { Id } from '@escapement/model'
import { Atom } from 'effect/reactivity'
import { createContext } from 'preact'
import { useContext } from 'preact/hooks'

/** A track's window, opened from its name in its head. */
export interface TrackWindows {
  /**
   * Closes the track's window if it is in sight, brings it forward if it is behind a tab; else opens it in place of the
   * track window last turned to, or, `alongside`, beside it, the other staying open.
   */
  readonly toggle: (track: Id, alongside: boolean) => void
  /** Whether the track's window is in sight. */
  readonly isShown: (track: Id) => Atom.Atom<boolean>
}

const never = Atom.make(false)

export const TrackWindowsContext = createContext<TrackWindows>({ toggle: () => {}, isShown: () => never })

export const useTrackWindows = () => useContext(TrackWindowsContext)
