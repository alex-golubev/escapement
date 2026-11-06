import type { Id } from '@escapement/model'
import { Atom } from 'effect/reactivity'
import { createContext } from 'preact'
import { useContext } from 'preact/hooks'

/** A channel's window, opened from its name in its row. */
export interface ChannelWindows {
  /**
   * Closes the channel's window if it is in sight, brings it forward if it is behind a tab; else opens it in place of
   * the channel window last turned to, or, `alongside`, beside it, the other staying open.
   */
  readonly toggle: (channel: Id, alongside: boolean) => void
  /** Whether the channel's window is in sight. */
  readonly isShown: (channel: Id) => Atom.Atom<boolean>
}

const never = Atom.make(false)

export const ChannelWindowsContext = createContext<ChannelWindows>({ toggle: () => {}, isShown: () => never })

export const useChannelWindows = () => useContext(ChannelWindowsContext)
