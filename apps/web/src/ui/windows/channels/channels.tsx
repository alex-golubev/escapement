import { useAtomSet, useAtomValue } from '@effect/atom-react'
import { barSteps, barTicks, HoldTarget, type Id, stepTicks, toggledSolo } from '@escapement/model'
import { Array, Boolean, Equal, Option } from 'effect'
import type { RefObject } from 'preact'
import { memo } from 'preact/compat'
import { useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks'
import { useCore } from '../../core-context'
import { NotesIcon, PencilIcon, TrashIcon } from '../../kit/icons'
import { useContextMenu } from '../../kit/menu'
import { NameField } from '../../kit/name-field'
import { useScreenScale } from '../../kit/screen-scale'
import { neighbourOf } from '../../kit/neighbour'
import { useFollow } from '../../parts/follow'
import { heardTickIn, setStyleVar, useFrame } from '../../parts/frames'
import { panThenVolume } from '../../parts/channel-strip'
import { useChannelWindows } from '../../parts/channel-windows'
import { usePianoRollWindow } from '../../parts/piano-roll-window'
import { InsertField } from '../../parts/insert-field'
import { SmallKnob } from '../../parts/knob'
import { useWindowBody } from '../../parts/window-body'
import './channels.css'
import { barsAcross, barsShown, beatSteps, laneOf, stepsWidth, xOf } from './geometry'
import { barGap, beatGap, stepGap, stepWidth } from './layout'
import { drawPreview } from './notes-preview'

/** The steps shown, by bar, and in a bar by beat. */
type Bars = ReadonlyArray<ReadonlyArray<ReadonlyArray<number>>>

const barsOf = (bars: number): Bars =>
  Array.makeBy(bars, (bar) => Array.chunksOf(Array.range(bar * barSteps, (bar + 1) * barSteps - 1), beatSteps))

/** A bar's number over its first step. */
const tickLabel = (step: number) =>
  Boolean.match(step % barSteps === 0, { onTrue: () => String(step / barSteps + 1), onFalse: () => '' })

/** A step by its bar and its place in the bar. */
const placeOf = (name: string, step: number) =>
  `${name}, bar ${Math.floor(step / barSteps) + 1}, step ${(step % barSteps) + 1}`

/** The steps' sizes, for the styles. */
const sizes = {
  '--step-w': `${stepWidth}px`,
  '--step-gap': `${stepGap}px`,
  '--beat-gap': `${beatGap}px`,
  '--bar-gap': `${barGap}px`
}

/** The steps and the tick of a column, none for no column. */
const columnOf = (grid: Element, step: Option.Option<number>) =>
  Option.match(step, {
    onNone: () => [],
    onSome: (at) => Array.fromIterable(grid.querySelectorAll(`[data-step="${at}"]`))
  })

/**
 * Reads only its own note: a click redraws this cell and no other, and a row drawn again leaves it be. Past the
 * pattern's end, a step switched on grows the pattern to its bar.
 */
const StepCell = memo(function StepCell({
  channel,
  name,
  step,
  past,
  pattern
}: {
  readonly channel: Id
  readonly name: string
  readonly step: number
  readonly past: boolean
  readonly pattern: Option.Option<Id>
}) {
  const { session, ops } = useCore()
  const on = useAtomValue(session.step(channel, step))
  const place = placeOf(name, step)
  return (
    <button
      type='button'
      class='step'
      data-step={step}
      aria-label={place}
      aria-pressed={on}
      data-hint={Option.match(pattern, {
        onNone: () => `${place}: no pattern plays, so there is nothing to put it in`,
        onSome: () =>
          Boolean.match(on, {
            onTrue: () => `${place}: on in the project, everyone hears it`,
            onFalse: () =>
              Boolean.match(past, {
                onTrue: () =>
                  `${place}: past the pattern's end. A click turns it on for everyone, and the pattern grows to this bar`,
                onFalse: () => `${place}: off. A click turns it on for everyone`
              })
          })
      })}
      disabled={Option.isNone(pattern)}
      onClick={() => Option.map(pattern, (id) => ops.toggleStep(id, channel, step))}
    />
  )
})

/** A row's steps, bar by bar; the bars past the pattern's end are darker. The row drawn again leaves them be. */
const Steps = memo(function Steps({
  channel,
  name,
  pattern,
  bars,
  patternBars
}: {
  readonly channel: Id
  readonly name: string
  readonly pattern: Option.Option<Id>
  readonly bars: Bars
  readonly patternBars: number
}) {
  return (
    <span class='steps'>
      {bars.map((beats, bar) => (
        <span key={bar} class='bar' data-past={bar >= patternBars}>
          {beats.map((steps, beat) => (
            <span key={beat} class='beat'>
              {steps.map((step) => (
                <StepCell
                  key={step}
                  channel={channel}
                  name={name}
                  step={step}
                  past={bar >= patternBars}
                  pattern={pattern}
                />
              ))}
            </span>
          ))}
        </span>
      ))}
    </span>
  )
})

/** The row going with the focus in it, however it goes: the focus to the name beside it, or else to +. */
const focusPast = (row: HTMLElement | null) =>
  Option.map(
    Option.filter(Option.fromNullishOr(row), (going) => going.contains(document.activeElement)),
    (going) =>
      Option.map(
        Option.orElse(neighbourOf(going, '.seq-row__name'), () =>
          Option.fromNullishOr(going.parentElement?.querySelector<HTMLElement>('.seq-add'))
        ),
        (next) => next.focus()
      )
  )

/**
 * The channel's name, a button: a click opens its window, with Alt beside the one open; F2 renames it, and so does its
 * menu, which also deletes it. Drawn again after a key settled its name, it takes the focus back.
 */
const ChannelName = ({
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
  const windows = useChannelWindows()
  const roll = usePianoRollWindow()
  const shown = useAtomValue(windows.isShown(id))
  const button = useRef<HTMLButtonElement>(null)
  useLayoutEffect(() => {
    Boolean.match(focusBack, { onTrue: () => button.current?.focus(), onFalse: () => {} })
  }, [])
  const menu = useContextMenu(() => ({
    title: name,
    items: [
      {
        label: 'Piano roll',
        icon: <NotesIcon />,
        hint: `Show ${name}'s notes in the piano roll`,
        chosen: () => roll.show(id)
      },
      { label: 'Rename', icon: <PencilIcon />, hint: `Rename ${name}, for everyone`, chosen: rename },
      {
        label: 'Delete',
        icon: <TrashIcon />,
        hint: `Delete ${name} from the project, for everyone; Cmd+Z or Ctrl+Z brings it back`,
        chosen: () => ops.deleteChannel(id)
      }
    ]
  }))
  return (
    <button
      ref={button}
      type='button'
      class='seq-row__name'
      aria-pressed={shown}
      data-hint={Boolean.match(shown, {
        onTrue: () =>
          `${name}'s window is open: a click closes it. F2 renames ${name}; a right click or Shift+F10, its menu`,
        onFalse: () =>
          `Open the window of ${name}, channel ${index} of the project; with Alt, beside the one open. F2 renames it; a right click or Shift+F10, its menu`
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

/**
 * In place of the steps and across the same bars, once they can't show all the channel's notes: the notes small, from
 * the lowest to the highest; a click opens them in the piano roll.
 */
const NotesPreview = ({
  channel,
  name,
  bars,
  patternBars
}: {
  readonly channel: Id
  readonly name: string
  readonly bars: number
  readonly patternBars: number
}) => {
  const { session } = useCore()
  const notes = useAtomValue(session.notes(channel))
  const roll = usePianoRollWindow()
  const canvas = useRef<HTMLCanvasElement>(null)
  // Drawn again as its size changes too: behind a tab, the dock takes the Channels window out of the page, where it has
  // none, and puts it back as it comes forward; and on a move to another screen.
  const scale = useScreenScale()
  useLayoutEffect(
    () =>
      Option.match(Option.fromNullishOr(canvas.current), {
        onNone: () => undefined,
        onSome: (drawn) => {
          drawPreview(drawn, notes, patternBars)
          const observer = new ResizeObserver(() => drawPreview(drawn, notes, patternBars))
          observer.observe(drawn)
          return () => observer.disconnect()
        }
      }),
    [notes, patternBars, bars, scale]
  )
  return (
    <button
      type='button'
      class='notes-preview'
      style={{ width: `${stepsWidth(bars)}px` }}
      aria-label={`${name}: notes`}
      data-hint={`${name}'s notes, more than steps can show: a click opens them in the piano roll`}
      onClick={() => roll.show(channel)}
    >
      <canvas ref={canvas} />
      <span class='notes-preview__now' />
    </button>
  )
}

/**
 * A channel's row: pan and volume, then the mixer strip it goes into, before its name; its name opens its window with its instrument's knobs and is changed
 * in place, M writes its mute, S puts it into this client's solo or out. A row not heard is faded.
 */
const ChannelRow = ({
  id,
  index,
  pattern,
  bars,
  patternBars
}: {
  readonly id: Id
  readonly index: number
  readonly pattern: Option.Option<Id>
  readonly bars: Bars
  readonly patternBars: number
}) => {
  const { registry, session, ops } = useCore()
  const channel = useAtomValue(session.project.channel(id))
  const heard = useAtomValue(session.heard)
  const { solo } = useAtomValue(session.listening)
  const showsSteps = useAtomValue(session.showsSteps(id))
  const setListening = useAtomSet(session.listening)
  const [naming, setNaming] = useState({ renaming: false, focusBack: false })
  const row = useRef<HTMLDivElement>(null)
  // Its DOM is still there as it goes: Preact takes it out after this.
  useLayoutEffect(() => () => focusPast(row.current), [])
  return Option.match(channel, {
    onNone: () => null,
    onSome: ({ name, mute, strip: values, insert }) => (
      <div ref={row} class='seq-row' data-unheard={!heard.includes(id)}>
        <span class='seq-row__lead'>
          <span class='seq-row__index num'>{index}</span>
          <span class='seq-row__strip'>
            {panThenVolume.map((param) => (
              <SmallKnob
                key={param.id}
                owner={name}
                param={param}
                value={values[param.id]}
                target={HoldTarget.ChannelStrip({ channel: id, param: param.id })}
              />
            ))}
          </span>
          <InsertField channel={id} owner={name} insert={insert} />
          {Boolean.match(naming.renaming, {
            onTrue: () => (
              <NameField
                name={name}
                label={`Name of channel ${index}`}
                hint='The name of the channel, for everyone: Enter or a click elsewhere keeps it, Esc leaves it as it was'
                class='seq-row__field'
                settled={(typed, focusBack) => {
                  Option.map(typed, (named) => ops.renameChannel(id, named))
                  setNaming({ renaming: false, focusBack })
                }}
              />
            ),
            onFalse: () => (
              <ChannelName
                id={id}
                index={index}
                name={name}
                focusBack={naming.focusBack}
                rename={() => setNaming({ renaming: true, focusBack: false })}
              />
            )
          })}
          <span class='seq-row__buttons'>
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
              onClick={() => Option.map(registry.get(session.project.channel(id)), (now) => ops.setMute(id, !now.mute))}
            >
              M
            </button>
            <button
              type='button'
              class='toggle toggle--local'
              aria-label={`${name}: solo`}
              aria-pressed={solo.includes(id)}
              data-hint={Boolean.match(solo.includes(id), {
                onTrue: () => `${name} is soloed for you only; the other tabs hear the whole pattern`,
                onFalse: () => `Solo ${name} for you only; the other tabs won't hear the change`
              })}
              onClick={() => setListening((state) => toggledSolo(state, id))}
            >
              S
            </button>
          </span>
        </span>
        {Boolean.match(showsSteps, {
          onTrue: () => <Steps channel={id} name={name} pattern={pattern} bars={bars} patternBars={patternBars} />,
          onFalse: () => <NotesPreview channel={id} name={name} bars={bars.length} patternBars={patternBars} />
        })}
      </div>
    )
  })
}

/**
 * Pinned over the rows as they scroll: + in the corner, which adds a channel with a synth after the others, and the
 * bars' numbers over the steps.
 */
const HeadRow = ({
  bars,
  patternBars,
  steps
}: {
  readonly bars: Bars
  readonly patternBars: number
  readonly steps: RefObject<HTMLSpanElement | null>
}) => {
  const { ops } = useCore()
  return (
    <div class='seq-row seq-row--head'>
      <span class='seq-row__lead'>
        <span class='seq-row__add'>
          <button
            type='button'
            class='btn seq-add'
            aria-label='Add a channel'
            data-hint='Add a channel with a synth to the project, for everyone'
            onClick={() => ops.addChannel()}
          >
            +
          </button>
        </span>
        <span class='seq-row__buttons' />
      </span>
      <span class='steps' ref={steps} aria-hidden='true'>
        {bars.map((beats, bar) => (
          <span key={bar} class='bar' data-past={bar >= patternBars}>
            {beats.map((ticks, beat) => (
              <span key={beat} class='beat'>
                {ticks.map((step) => (
                  <span key={step} class='tick num' data-step={step}>
                    {tickLabel(step)}
                  </span>
                ))}
              </span>
            ))}
          </span>
        ))}
      </span>
    </div>
  )
}

/** Where the steps start in the body, as it stands unscrolled: right of the names, which stay as it scrolls. */
const stepsStartIn = (body: HTMLElement, steps: HTMLElement) =>
  steps.getBoundingClientRect().left - body.getBoundingClientRect().left - body.clientLeft + body.scrollLeft

/** A length the styles give in pixels; none given, none. */
const pixels = (length: string) =>
  Option.getOrElse(Option.liftPredicate(Number.parseFloat(length), Number.isFinite), () => 0)

/**
 * How wide the steps could be for the Channels window to fill the body across: all of it but its padding and what is
 * around them.
 */
const stepsRoomIn = (body: HTMLElement, grid: HTMLElement, steps: HTMLElement) => {
  const { paddingLeft, paddingRight } = getComputedStyle(body)
  return (
    body.clientWidth -
    pixels(paddingLeft) -
    pixels(paddingRight) -
    (grid.getBoundingClientRect().width - steps.getBoundingClientRect().width)
  )
}

/**
 * A row for each channel of the project, drawing the document whatever wrote it, and the playhead over the column
 * heard now, and over the previews of notes where it is. With no pattern, the steps are off. Its bars are the pattern's,
 * one past it and as many more as its window's body has room for; wider than the body, the steps scroll across under
 * the names, and follow the playhead while it is in sight, as the piano roll does.
 */
export const StepGrid = () => {
  const { session } = useCore()
  const ids = useAtomValue(session.project.channelIds)
  const pattern = useAtomValue(session.pattern)
  const patternBars = useAtomValue(session.patternEnd) / barTicks
  const body = useWindowBody()
  const grid = useRef<HTMLDivElement>(null)
  const headSteps = useRef<HTMLSpanElement>(null)
  const [fit, setFit] = useState(0)
  // Where the steps start in the body, right of the names, and how wide they are in sight, as last measured: none
  // behind a tab.
  const start = useRef(0)
  const sight = useRef(0)
  // Where the body is scrolled across, as the Channels window last saw or put it: a scroll elsewhere is by hand.
  const known = useRef(0)
  const held = useRef(false)
  const playhead = useFollow()
  const bars = useMemo(() => barsOf(barsShown(patternBars, fit)), [patternBars, fit])
  // Measured as the body is resized, not each frame: what is around the steps stays as wide.
  useLayoutEffect(
    () =>
      Option.match(
        Option.all({
          scroller: Option.fromNullishOr(body.current),
          grid: Option.fromNullishOr(grid.current),
          steps: Option.fromNullishOr(headSteps.current)
        }),
        {
          onNone: () => undefined,
          onSome: ({ scroller, grid, steps }) => {
            const measure = () => {
              start.current = stepsStartIn(scroller, steps)
              sight.current = scroller.clientWidth - start.current
              setFit(barsAcross(stepsRoomIn(scroller, grid, steps)))
            }
            measure()
            const observer = new ResizeObserver(measure)
            observer.observe(scroller)
            return () => observer.disconnect()
          }
        }
      ),
    [body]
  )
  // A press anywhere on the body, its scroll bar too, holds the steps still until let go of, wherever that is.
  useLayoutEffect(
    () =>
      Option.match(Option.fromNullishOr(body.current), {
        onNone: () => undefined,
        onSome: (scroller) => {
          known.current = scroller.scrollLeft
          const scrolled = () => {
            playhead.scrolled(Math.abs(scroller.scrollLeft - known.current) >= 1)
            known.current = scroller.scrollLeft
          }
          // A step the focus goes to under the names or past them comes out right of them: the browser takes one under
          // them for in sight, and scrolls to one past an edge after this.
          const focused = (event: FocusEvent) =>
            Option.map(
              Option.liftPredicate(
                event.target,
                (target): target is HTMLElement => target instanceof HTMLElement && target.classList.contains('step')
              ),
              (step) => {
                const covered =
                  scroller.getBoundingClientRect().left +
                  scroller.clientLeft +
                  start.current -
                  step.getBoundingClientRect().left
                scroller.scrollLeft -= Math.max(covered, 0)
              }
            )
          const pressed = (event: PointerEvent) => {
            held.current = event.button === 0
          }
          const letGo = () => {
            held.current = false
          }
          scroller.addEventListener('scroll', scrolled)
          scroller.addEventListener('pointerdown', pressed)
          scroller.addEventListener('focusin', focused)
          window.addEventListener('pointerup', letGo)
          window.addEventListener('pointercancel', letGo)
          window.addEventListener('blur', letGo)
          return () => {
            scroller.removeEventListener('scroll', scrolled)
            scroller.removeEventListener('pointerdown', pressed)
            scroller.removeEventListener('focusin', focused)
            window.removeEventListener('pointerup', letGo)
            window.removeEventListener('pointercancel', letGo)
            window.removeEventListener('blur', letGo)
          }
        }
      }),
    [body]
  )
  const marked = useRef(Option.none<number>())
  // Marks the column on elements Preact draws, in an attribute it doesn't: a row drawn again leaves the mark be. Each
  // frame, as a row may come in the middle of a step.
  useFrame((frame) => {
    const tick = heardTickIn('pattern', frame)
    Option.map(
      Option.all({
        scroller: Option.fromNullishOr(body.current),
        left: playhead.frame(
          Option.liftPredicate(laneOf(known.current, sight.current), ({ width }) => width > 0),
          held.current,
          tick
        )
      }),
      ({ scroller, left }) => {
        scroller.scrollLeft = left
        known.current = scroller.scrollLeft
      }
    )
    const now = Option.map(tick, (at) => Math.floor(at / stepTicks))
    Option.match(Option.fromNullishOr(grid.current), {
      onNone: () => {},
      onSome: (drawn) => {
        drawn.querySelectorAll<HTMLElement>('.notes-preview').forEach((preview) =>
          Option.match(tick, {
            onNone: () => preview.removeAttribute('data-now'),
            onSome: (at) => {
              setStyleVar(preview, '--now-x', `${xOf(at)}px`)
              Boolean.match(preview.hasAttribute('data-now'), {
                onTrue: () => {},
                onFalse: () => preview.setAttribute('data-now', 'true')
              })
            }
          })
        )
        Option.match(
          Option.liftPredicate(marked.current, (was) => !Equal.equals(was, now)),
          {
            onNone: () => {},
            onSome: (was) => columnOf(drawn, was).forEach((element) => element.removeAttribute('data-now'))
          }
        )
        columnOf(drawn, now)
          .filter((element) => !element.hasAttribute('data-now'))
          .forEach((element) => element.setAttribute('data-now', 'true'))
        marked.current = now
      }
    })
  })
  return (
    <div class='seq-frame'>
      <div class='seq' ref={grid} style={sizes} aria-label='Pattern'>
        <HeadRow bars={bars} patternBars={patternBars} steps={headSteps} />
        {ids.map((id, i) => (
          <ChannelRow key={id} id={id} index={i + 1} pattern={pattern} bars={bars} patternBars={patternBars} />
        ))}
      </div>
      <span class='seq-edge' aria-hidden='true' />
    </div>
  )
}

/** The name of the pattern that plays, beside the window's title. */
export const PatternName = () => {
  const { session } = useCore()
  return Option.getOrElse(useAtomValue(session.patternName), () => 'No pattern')
}
