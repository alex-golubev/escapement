import { useAtomValue } from '@effect/atom-react'
import type { Id } from '@escapement/model'
import { Option } from 'effect'
import type { ComponentChildren } from 'preact'
import { Shown } from '../../../services/view-store'
import { useCore } from '../../core-context'
import { PianoRoll, useNoteLength } from '../../windows/piano-roll/piano-roll'
import { TrackSettings, useTrackName } from '../../windows/track/track'
import './panel.css'

/** The panel showing a track or its notes, the chosen track's name and which of the two over them. */
const ShownBelow = ({
  track,
  kind,
  fills,
  children
}: {
  readonly track: Id
  readonly kind: string
  readonly fills: boolean
  readonly children: ComponentChildren
}) => {
  const name = useTrackName(track)
  return (
    <section class='panel' aria-label={`${name}, ${kind.toLowerCase()}`}>
      <div class='panel__title'>
        <span class='panel__name'>{name}</span>
        <span class='panel__rule' aria-hidden='true'>
          |
        </span>
        <span class='panel__kind'>{kind}</span>
      </div>
      <div class='panel__body' data-fills={fills}>
        {children}
      </div>
    </section>
  )
}

/** Under the middle: the last thing chosen, a track or a clip's notes, yours alone; a line over it tells which. */
export const Panel = () => {
  const { view } = useCore()
  const below = useAtomValue(view.below)
  const track = useAtomValue(view.track)
  const length = useNoteLength()
  return Option.match(Option.all({ below, track }), {
    onNone: () => (
      <section class='panel' aria-label='Nothing chosen'>
        <div class='panel__title' />
        <p class='panel__none'>Click a track's name to see it here, double-click a clip for its notes</p>
      </section>
    ),
    onSome: ({ below, track }) => {
      const { kind, fills, body } = Shown.match(below, {
        Track: () => ({ kind: 'Track', fills: false, body: <TrackSettings key={track} track={track} /> }),
        Notes: ({ clip }) => ({ kind: 'Notes', fills: true, body: <PianoRoll clip={clip} length={length} /> })
      })
      return (
        <ShownBelow track={track} kind={kind} fills={fills}>
          {body}
        </ShownBelow>
      )
    }
  })
}
