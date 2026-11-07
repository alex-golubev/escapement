import { useAtomSet, useAtomValue } from '@effect/atom-react'
import { HoldTarget, type Id, toggledSolo } from '@escapement/model'
import { Boolean, Option } from 'effect'
import { memo } from 'preact/compat'
import { useLayoutEffect, useRef, useState } from 'preact/hooks'
import { useCore } from '../../core-context'
import { PencilIcon, TrashIcon } from '../../kit/icons'
import { useContextMenu } from '../../kit/menu'
import { NameField } from '../../kit/name-field'
import { neighbourOf } from '../../kit/neighbour'
import { SmallKnob } from '../../parts/knob'
import { useTrackWindows } from '../../parts/track-windows'
import { panThenVolume } from '../../parts/track-strip'

/** The head going with the focus in it, however it goes: the focus to the name beside it, or else to +. */
const focusPast = (head: HTMLElement | null) =>
  Option.map(
    Option.filter(Option.fromNullishOr(head), (going) => going.contains(document.activeElement)),
    (going) =>
      Option.map(
        Option.orElse(neighbourOf(going, '.track-head__name'), () =>
          Option.fromNullishOr(going.parentElement?.querySelector<HTMLElement>('.track-add'))
        ),
        (next) => next.focus()
      )
  )

/** Drawn again after a key settled the name, it takes the focus back. */
const TrackName = ({
  id,
  index,
  name,
  focusBack,
  rename
}: {
  readonly id: Id
  readonly index: number
  readonly name: string
  readonly focusBack: boolean
  readonly rename: () => void
}) => {
  const { ops } = useCore()
  const windows = useTrackWindows()
  const shown = useAtomValue(windows.isShown(id))
  const button = useRef<HTMLButtonElement>(null)
  useLayoutEffect(() => {
    Boolean.match(focusBack, { onTrue: () => button.current?.focus(), onFalse: () => {} })
  }, [])
  const menu = useContextMenu(() => ({
    title: name,
    items: [
      { label: 'Rename', icon: <PencilIcon />, hint: `Rename ${name}, for everyone`, chosen: rename },
      {
        label: 'Delete',
        icon: <TrashIcon />,
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
      aria-pressed={shown}
      data-hint={Boolean.match(shown, {
        onTrue: () =>
          `${name}'s window is open: a click closes it. F2 renames ${name}; a right click or Shift+F10, its menu`,
        onFalse: () =>
          `Open the window of ${name}, track ${index} of the project; with Alt, beside the one open. F2 renames it; a right click or Shift+F10, its menu`
      })}
      // Alt as the click has it, from the mouse or from Enter.
      onClick={(event) => windows.toggle(id, event.altKey)}
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
  const { registry, session, ops } = useCore()
  const track = useAtomValue(session.project.track(id))
  const heard = useAtomValue(session.heard)
  const { solo } = useAtomValue(session.listening)
  const setListening = useAtomSet(session.listening)
  const [naming, setNaming] = useState({ renaming: false, focusBack: false })
  const head = useRef<HTMLDivElement>(null)
  // Its DOM is still there as it goes: Preact takes it out after this.
  useLayoutEffect(() => () => focusPast(head.current), [])
  return Option.match(track, {
    onNone: () => null,
    onSome: ({ name, mute, strip: values }) => (
      <div ref={head} class='track-head' data-unheard={!heard.includes(id)}>
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
              focusBack={naming.focusBack}
              rename={() => setNaming({ renaming: true, focusBack: false })}
            />
          )
        })}
        <span class='track-head__buttons'>
          <button
            type='button'
            class='toggle toggle--shared'
            aria-label={`${name}: mute`}
            aria-pressed={mute}
            data-hint={Boolean.match(mute, {
              onTrue: () => `${name} is muted in the project, for everyone`,
              onFalse: () => `Mute ${name} in the project, for everyone`
            })}
            // The document's mute now, which may be ahead of the one drawn.
            onClick={() => Option.map(registry.get(session.project.track(id)), (now) => ops.setMute(id, !now.mute))}
          >
            M
          </button>
          <button
            type='button'
            class='toggle toggle--local'
            aria-label={`${name}: solo`}
            aria-pressed={solo.includes(id)}
            data-hint={Boolean.match(solo.includes(id), {
              onTrue: () => `${name} is soloed for you only; the other tabs hear the whole arrangement`,
              onFalse: () => `Solo ${name} for you only; the other tabs won't hear the change`
            })}
            onClick={() => setListening((state) => toggledSolo(state, id))}
          >
            S
          </button>
        </span>
      </div>
    )
  })
})

/** Scrolled by the page with the rows, + under the last. */
export const TrackHeads = ({ top }: { readonly top: number }) => {
  const { session, ops } = useCore()
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
            data-hint='Add a track with a synth to the project, for everyone'
            onClick={() => ops.addTrack()}
          >
            +
          </button>
        </div>
      </div>
    </div>
  )
}
