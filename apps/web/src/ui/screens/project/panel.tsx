import { useAtomValue } from '@effect/atom-react'
import type { Id } from '@escapement/model'
import { Boolean, Option } from 'effect'
import type { ComponentChildren } from 'preact'
import { Shown } from '../../../services/view-store'
import { useCore } from '../../core-context'
import { ChevronIcon } from '../../kit/icons'
import { PianoRoll, useNoteLength } from '../../views/piano-roll/piano-roll'
import { TrackSettings, useTrackName } from '../../views/track/track'
import './panel.css'

/** The panel: a title line over what it shows, with a button folding it to the line; folded, it shows only the line. */
const Frame = ({
  label,
  title,
  children
}: {
  readonly label: string
  readonly title: ComponentChildren
  readonly children: ComponentChildren
}) => {
  const { view } = useCore()
  const { folded } = useAtomValue(view.panel)
  return (
    <section class='panel' aria-label={label} data-folded={folded}>
      <div class='panel__title'>
        {title}
        <button
          type='button'
          class='btn panel__fold'
          aria-expanded={!folded}
          aria-label={Boolean.match(folded, { onTrue: () => 'Unfold the panel', onFalse: () => 'Fold the panel' })}
          data-hint={Boolean.match(folded, {
            onTrue: () => 'Unfold the panel to the height it had',
            onFalse: () => 'Fold the panel to this line, for the middle to have the room'
          })}
          onClick={() => view.fold(!folded)}
        >
          <ChevronIcon />
        </button>
      </div>
      {Boolean.match(folded, { onTrue: () => null, onFalse: () => children })}
    </section>
  )
}

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
    <Frame
      label={`${name}, ${kind.toLowerCase()}`}
      title={
        <>
          <span class='panel__name'>{name}</span>
          <span class='panel__rule' aria-hidden='true'>
            |
          </span>
          <span class='panel__kind'>{kind}</span>
        </>
      }
    >
      <div class='panel__body' data-fills={fills}>
        {children}
      </div>
    </Frame>
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
      <Frame label='Nothing chosen' title={null}>
        <p class='panel__none'>Click a track's name to see it here, double-click a clip for its notes</p>
      </Frame>
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
