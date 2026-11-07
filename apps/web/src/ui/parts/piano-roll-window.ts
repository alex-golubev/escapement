import type { Id } from '@escapement/model'
import { Option } from 'effect'
import { Atom } from 'effect/reactivity'
import { createContext } from 'preact'
import { useContext } from 'preact/hooks'

/** The one piano roll of the project: the notes of one clip at a time. */
export interface PianoRollWindow {
  /** Shows the clip's notes, opening the window or bringing it forward. */
  readonly show: (clip: Id) => void
  /** The clip it shows: the one last opened, while it is live; none before one is, and while it is gone. */
  readonly clip: Atom.Atom<Option.Option<Id>>
}

export const PianoRollContext = createContext<PianoRollWindow>({
  show: () => {},
  clip: Atom.make(Option.none<Id>())
})

export const usePianoRollWindow = () => useContext(PianoRollContext)
