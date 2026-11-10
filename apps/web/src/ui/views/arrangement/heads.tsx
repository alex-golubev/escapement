import { useAtomValue } from '@effect/atom-react'
import { HoldTarget, type Id } from '@escapement/model'
import { Boolean, Option } from 'effect'
import { Pencil, Trash } from 'lucide-preact'
import { memo } from 'preact/compat'
import { useLayoutEffect, useRef, useState } from 'preact/hooks'
import { useCore } from '../../core-context'
import { useContextMenu } from '../../kit/menu'
import { NameField } from '../../kit/name-field'
import { focusPast } from '../../kit/neighbour'
import { SmallKnob } from '../../parts/knob'
import { choiceHint, TrackToggles, trackGroup } from '../../parts/track-buttons'
import { panThenVolume } from '../../parts/track-strip'

/** Drawn again after a key settled the name, it takes the focus back. */
const TrackName = ({
  id,
  index,
  name,
  chosen,
  focusBack,
  rename
}: {
  readonly id: Id
  readonly index: number
  readonly name: string
  readonly chosen: boolean
  readonly focusBack: boolean
  readonly rename: () => void
}) => {
  const { ops, view } = useCore()
  const notesBelow = useAtomValue(view.hasNotesBelow(id))
  const button = useRef<HTMLButtonElement>(null)
  useLayoutEffect(() => {
    Boolean.match(focusBack, { onTrue: () => button.current?.focus(), onFalse: () => {} })
  }, [])
  const menu = useContextMenu(() => ({
    title: name,
    items: [
      { label: 'Rename', icon: <Pencil />, hint: `Rename ${name}, for everyone`, chosen: rename },
      {
        label: 'Delete',
        icon: <Trash />,
        hint: `Delete ${name} and its clips from the project, for everyone; Cmd+Z or Ctrl+Z brings them back`,
        chosen: () => ops.deleteTrack(id)
      }
    ]
  }))
  return (
    <button
      ref={button}
      type='button'
      class='track-head__name'
      aria-current={chosen}
      data-hint={`${choiceHint(name, index, chosen, notesBelow)}. F2 renames it; a right click or Shift+F10, its menu`}
      onClick={() => view.show(id)}
      onContextMenu={menu.onContextMenu}
      onKeyDown={(event) =>
        Boolean.match(event.key === 'F2', {
          onTrue: () => {
            event.preventDefault()
            rename()
          },
          onFalse: () => menu.onKeyDown(event)
        })
      }
    >
      {name}
    </button>
  )
}

/** Drawn again only as what it reads changes, not as the heads scroll. */
const TrackHead = memo(function TrackHead({ id, index }: { readonly id: Id; readonly index: number }) {
  const { session, ops, view } = useCore()
  const track = useAtomValue(session.project.track(id))
  const chosen = useAtomValue(view.isChosen(id))
  const heard = useAtomValue(session.isHeard(id))
  const [naming, setNaming] = useState({ renaming: false, focusBack: false })
  const head = useRef<HTMLDivElement>(null)
  // Its DOM is still there as it goes: Preact takes it out after this. The last one's focus goes to +.
  useLayoutEffect(
    () => () =>
      focusPast(head.current, '.track-head__name', (going) =>
        going.parentElement?.querySelector<HTMLElement>('.track-add')
      ),
    []
  )
  return Option.match(track, {
    onNone: () => null,
    onSome: ({ name, mute, strip: values }) => (
      <div
        ref={head}
        class='track-head'
        role='group'
        aria-label={trackGroup(name, index)}
        data-unheard={!heard}
        data-chosen={chosen}
      >
        <span class='track-head__strip'>
          {panThenVolume.map((param) => (
            <SmallKnob
              key={param.id}
              owner={name}
              param={param}
              value={values[param.id]}
              target={HoldTarget.TrackStrip({ track: id, param: param.id })}
            />
          ))}
        </span>
        {Boolean.match(naming.renaming, {
          onTrue: () => (
            <NameField
              name={name}
              label={`Name of track ${index}`}
              hint='The name of the track, for everyone: Enter or a click elsewhere keeps it, Esc leaves it as it was'
              class='track-head__field'
              settled={(typed, focusBack) => {
                Option.map(typed, (named) => ops.renameTrack(id, named))
                setNaming({ renaming: false, focusBack })
              }}
            />
          ),
          onFalse: () => (
            <TrackName
              id={id}
              index={index}
              name={name}
              chosen={chosen}
              focusBack={naming.focusBack}
              rename={() => setNaming({ renaming: true, focusBack: false })}
            />
          )
        })}
        <span class='track-head__buttons'>
          <TrackToggles id={id} name={name} mute={mute} />
        </span>
      </div>
    )
  })
})

/** Scrolled by the page with the rows, + under the last. */
export const TrackHeads = ({ top }: { readonly top: number }) => {
  const { session, ops, view } = useCore()
  const ids = useAtomValue(session.project.trackIds)
  return (
    <div class='track-heads'>
      <div class='track-heads__rows' style={{ transform: `translateY(${-top}px)` }}>
        {ids.map((id, i) => (
          <TrackHead key={id} id={id} index={i + 1} />
        ))}
        <div class='track-head track-head--add'>
          <button
            type='button'
            class='btn track-add'
            aria-label='Add a track'
            data-hint='Add a track with a synth to the project, for everyone, and show it below'
            onClick={() => Option.map(ops.addTrack(), view.show)}
          >
            +
          </button>
        </div>
      </div>
    </div>
  )
}
