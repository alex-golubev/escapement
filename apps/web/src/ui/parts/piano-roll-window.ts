import type { Id, Pattern } from '@escapement/model'
import { Array, Option } from 'effect'
import { Atom } from 'effect/reactivity'
import { createContext } from 'preact'
import { useContext } from 'preact/hooks'

/** The one piano roll of the project: the notes of one channel at a time. */
export interface PianoRollWindow {
  /** Shows the channel's notes, opening the window or bringing it forward. */
  readonly show: (channel: Id) => void
  /** The channel it shows; none in a project without channels. */
  readonly channel: Atom.Atom<Option.Option<Id>>
}

/**
 * The channel last chosen while it is there; else, as on a change of pattern, the first channel with notes, or the
 * first one.
 */
export const shownChannel = (
  chosen: Option.Option<Id>,
  channels: ReadonlyArray<Id>,
  pattern: Option.Option<Pattern>
): Option.Option<Id> =>
  Option.filter(chosen, (id) => channels.includes(id)).pipe(
    Option.orElse(() =>
      Array.findFirst(channels, (id) =>
        Option.exists(pattern, ({ notes }) => notes.some(({ channel }) => channel === id))
      )
    ),
    Option.orElse(() => Array.head(channels))
  )

export const PianoRollContext = createContext<PianoRollWindow>({
  show: () => {},
  channel: Atom.make(Option.none<Id>())
})

export const usePianoRollWindow = () => useContext(PianoRollContext)
