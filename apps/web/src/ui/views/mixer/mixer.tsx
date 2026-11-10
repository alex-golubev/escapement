import { useAtomValue } from '@effect/atom-react'
import { type AnyParam, type StripParamId, strip } from '@escapement/engine-description'
import { byContent, HoldTarget, type Id, trackStrip } from '@escapement/model'
import { Array, Number, Option } from 'effect'
import { memo } from 'preact/compat'
import { useContext, useLayoutEffect, useMemo, useRef } from 'preact/hooks'
import { useCore } from '../../core-context'
import { useLaidOutSize } from '../../kit/laid-out'
import { focusPast } from '../../kit/neighbour'
import { pixelsOf } from '../../kit/pixels'
import { useRem } from '../../kit/rem'
import { Fader, type FaderMarks } from '../../parts/fader'
import { setFlag, setStyleVar, useFrame } from '../../parts/frames'
import { Knob } from '../../parts/knob'
import { meterPosition } from '../../parts/levels'
import { choiceHint, TrackToggles, trackGroup } from '../../parts/track-buttons'
import { type MeterKey, MeterBoardContext, masterMeter, type Side, trackMeter } from '../../parts/meter-board'
import './mixer.css'

const sideNames = ['left', 'right'] as const

/** A strip's volume and pan, by their descriptions: the engine's for the master, a track's for a track. */
type StripParams = Readonly<Record<StripParamId, AnyParam>>

const paramsOf = (params: ReadonlyArray<AnyParam & { readonly id: StripParamId }>): StripParams => {
  const of = (id: StripParamId) => Option.getOrThrow(Array.findFirst(params, (param) => param.id === id))
  return { volume: of('volume'), pan: of('pan') }
}

const masterParams = paramsOf(strip)
const trackParams = paramsOf(trackStrip)

/** One side of what a strip passes on: its level, and the lamp over it until clicked. */
const Meter = ({ output, meter, side }: { readonly output: string; readonly meter: MeterKey; readonly side: Side }) => {
  const board = useContext(MeterBoardContext)
  const fill = useRef<HTMLSpanElement>(null)
  const lamp = useRef<HTMLButtonElement>(null)
  // Drawn anew, its strip scrolled back, it shows its lamp at once, frames or none.
  useLayoutEffect(() => setFlag(lamp.current, 'data-lit', board.lit(meter, side)), [board, meter, side])
  useFrame((frame) => {
    // Taken in once a frame for every meter, whichever draws first.
    board.follow(frame)
    setStyleVar(fill.current, '--level', meterPosition(board.level(meter, side)).toFixed(3))
    setFlag(lamp.current, 'data-lit', board.lit(meter, side))
  })
  const name = sideNames[side]
  return (
    <span
      class='strip__meter'
      data-hint={`${output}, ${name}. The lamp latches on a peak over full scale; click it to put it out`}
    >
      <button
        type='button'
        class='meter-clip'
        ref={lamp}
        aria-label={`${output}: clip, ${name}`}
        onClick={() => {
          board.putOut(meter, side)
          setFlag(lamp.current, 'data-lit', false)
        }}
      />
      <span class='meter'>
        <span class='meter__fill' ref={fill} />
      </span>
    </span>
  )
}

/** The pan knob and the fader of a strip, its meters beside the fader. */
const StripControls = ({
  owner,
  params,
  values,
  targetOf,
  marks,
  meter
}: {
  readonly owner: string
  readonly params: StripParams
  readonly values: { readonly volume: number; readonly pan: number }
  readonly targetOf: (param: StripParamId) => HoldTarget
  readonly marks: FaderMarks
  readonly meter: MeterKey
}) => (
  <div class='strip__controls'>
    <Knob owner={owner} param={params.pan} value={values.pan} target={targetOf('pan')} />
    <span class='strip__level'>
      <Fader owner={owner} param={params.volume} value={values.volume} target={targetOf('volume')} marks={marks} />
      <span class='strip__meters'>
        <Meter output={`${owner} output`} meter={meter} side={0} />
        <Meter output={`${owner} output`} meter={meter} side={1} />
      </span>
    </span>
  </div>
)

/** The master: its pan, its fader and the engine's output. */
const MasterStrip = () => {
  const { session } = useCore()
  const { strip: values } = useAtomValue(session.project.master)
  return (
    <div class='strip strip--master' role='group' aria-label='Master'>
      <span class='strip__title'>Master</span>
      <StripControls
        owner='Master'
        params={masterParams}
        values={values}
        targetOf={(param) => HoldTarget.MasterStrip({ param })}
        marks='numbered'
        meter={masterMeter}
      />
    </div>
  )
}

/** A track's strip: its name, which shows it below, M and S as in its head, its pan, its fader and its meters. */
const TrackStrip = memo(function TrackStrip({ id, index }: { readonly id: Id; readonly index: number }) {
  const { registry, session, view } = useCore()
  const track = useAtomValue(session.project.track(id))
  const chosen = useAtomValue(view.isChosen(id))
  const notesBelow = useAtomValue(view.hasNotesBelow(id))
  const heard = useAtomValue(session.isHeard(id))
  const box = useRef<HTMLDivElement>(null)
  // As in a track's head, once the track is gone, the last one's to the master; scrolled out, the strip lets it go.
  useLayoutEffect(
    () => () =>
      Option.map(Option.liftPredicate(registry.get(session.project.track(id)), Option.isNone), () =>
        focusPast(box.current, '.strip__name', (going) =>
          going.closest('.mixer')?.querySelector<HTMLElement>('.strip--master [role="slider"]')
        )
      ),
    []
  )
  return Option.match(track, {
    onNone: () => null,
    onSome: ({ name, colour, mute, strip: values }) => (
      <div
        ref={box}
        class='strip strip--track'
        role='group'
        aria-label={trackGroup(name, index)}
        data-unheard={!heard}
        data-chosen={chosen}
        style={{ '--track-colour': colour }}
      >
        <button
          type='button'
          class='strip__name'
          aria-current={chosen}
          data-hint={choiceHint(name, index, chosen, notesBelow)}
          onClick={() => view.show(id)}
        >
          {name}
        </button>
        <span class='strip__buttons'>
          <TrackToggles id={id} name={name} mute={mute} />
        </span>
        <StripControls
          owner={name}
          params={trackParams}
          values={values}
          targetOf={(param) => HoldTarget.TrackStrip({ track: id, param })}
          marks='bare'
          meter={trackMeter(id)}
        />
      </div>
    )
  })
})

// A strip and the gap after it across, in rems: the rack lays its strips out by these, and draws only those in sight.
const stripWidth = 4.75
const stripGap = 0.25

/** The strips drawn, of `count`: those in sight across `width`, and at least one more each side, for a scroll or Tab. */
const drawnOf = (past: number, width: number, count: number, step: number) => {
  const first = Number.clamp(past - 1, { minimum: 0, maximum: count })
  return { first, end: Number.clamp(past + Math.ceil(width / step) + 2, { minimum: first, maximum: count }) }
}

/** The tracks' strips in their order, scrolled across from where the page last left them: only those in sight drawn. */
const TrackRack = () => {
  const { registry, session, view } = useCore()
  const ids = useAtomValue(session.project.trackIds)
  const rack = useRef<HTMLDivElement>(null)
  const rem = useRem()
  const width = pixelsOf(rem, stripWidth)
  const gap = pixelsOf(rem, stripGap)
  const step = width + gap
  // The whole strips scrolled past: drawn again as a strip comes into sight or goes, not at each pixel scrolled.
  const past = useAtomValue(useMemo(() => byContent((get) => Math.floor(get(view.rackScroll))), [view]))
  const room = Option.match(useLaidOutSize(rack), { onNone: () => 0, onSome: ({ width }) => width })
  // Scrolled in strips, so a page grown shows the same ones: in pixels again as the strips' size changes.
  useLayoutEffect(() => {
    Option.map(Option.fromNullishOr(rack.current), (shown) => {
      shown.scrollLeft = registry.get(view.rackScroll) * step
    })
  }, [registry, view, step])
  // The browser stops a scroll short of the strips' end, as they go or the rack widens, and tells no one.
  useLayoutEffect(() => {
    Option.map(Option.fromNullishOr(rack.current), (shown) => registry.set(view.rackScroll, shown.scrollLeft / step))
  }, [registry, view, ids.length, room, step])
  const { first, end } = drawnOf(past, room, ids.length, step)
  return (
    <div
      class='rack'
      ref={rack}
      onScroll={(event) => registry.set(view.rackScroll, event.currentTarget.scrollLeft / step)}
    >
      <div
        class='rack__strips'
        style={{
          '--strip-w': `${width}px`,
          gap: `${gap}px`,
          width: `calc(${Math.max(ids.length * step - gap, 0)}px + 2 * var(--rack-room))`,
          paddingLeft: `calc(${first * step}px + var(--rack-room))`
        }}
      >
        {ids.slice(first, end).map((id, i) => (
          <TrackStrip key={id} id={id} index={first + i + 1} />
        ))}
      </div>
    </div>
  )
}

/** The tracks' strips, then the master, pinned. */
export const Mixer = () => (
  <div class='mixer'>
    <TrackRack />
    <MasterStrip />
  </div>
)
