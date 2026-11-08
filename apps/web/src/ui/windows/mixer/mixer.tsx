import { useAtomValue } from '@effect/atom-react'
import { type StripParamId, strip } from '@escapement/engine-description'
import { HoldTarget, type Id, insertCount, master, mixerInserts } from '@escapement/model'
import { Boolean, Number, Option } from 'effect'
import { createContext } from 'preact'
import { useContext, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks'
import { useLaidOutSize } from '../../kit/laid-out'
import { useCore } from '../../core-context'
import { Fader, type FaderMarks } from '../../parts/fader'
import { setFlag, setStyleVar, useFrame } from '../../parts/frames'
import { InstanceControls } from '../../parts/instance-controls'
import { Knob } from '../../parts/knob'
import { meterPosition } from '../../parts/levels'
import { masterMeter, meterBoard, type Side } from './meter-board'
import './mixer.css'

const sideNames = ['left', 'right'] as const

/** The engine's strip by ID: an insert's volume and pan, the master's too. */
const stripParam = (id: StripParamId) =>
  Option.getOrThrow(Option.fromUndefinedOr(strip.find((param) => param.id === id)))
const volume = stripParam('volume')
const pan = stripParam('pan')

/** The meters of the mixer's strips, the master's too, as the engine's board tells them. */
const MeterBoardContext = createContext(meterBoard())

/** One side of what a strip passes on, by its meter's number: its level, and the lamp over it until clicked. */
const Meter = ({ output, meter, side }: { readonly output: string; readonly meter: number; readonly side: Side }) => {
  const board = useContext(MeterBoardContext)
  const fill = useRef<HTMLSpanElement>(null)
  const lamp = useRef<HTMLButtonElement>(null)
  // Lit while out of sight, it comes back lit.
  useLayoutEffect(() => setFlag(lamp.current, 'data-lit', board.lit(meter, side)), [board, meter, side])
  useFrame((frame) => {
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

/** Both sides of what a strip passes on. */
const Meters = ({ output, meter }: { readonly output: string; readonly meter: number }) => (
  <span class='strip__meters'>
    <Meter output={output} meter={meter} side={0} />
    <Meter output={output} meter={meter} side={1} />
  </span>
)

/** The pan knob and the fader of an insert's strip, the master's too, at the strip's foot so the faders line up. */
const StripControls = ({
  owner,
  insert,
  values,
  marks,
  meter
}: {
  readonly owner: string
  readonly insert: Id
  readonly values: { readonly volume: number; readonly pan: number }
  readonly marks: FaderMarks
  readonly meter: number
}) => (
  <div class='strip__foot'>
    <Knob owner={owner} param={pan} value={values.pan} target={HoldTarget.InsertStrip({ insert, param: 'pan' })} />
    <span class='strip__level'>
      <Fader
        owner={owner}
        param={volume}
        value={values.volume}
        target={HoldTarget.InsertStrip({ insert, param: 'volume' })}
        marks={marks}
      />
      <Meters output={`${owner} output`} meter={meter} />
    </span>
  </div>
)

/** The master: its chain of plugins, the knobs of each, its pan and fader, and its output. */
export const MasterStrip = () => {
  const { session } = useCore()
  const { slots, strip: values } = useAtomValue(session.project.master)
  return (
    <div class='strip strip--master'>
      <div class='strip__head'>
        <span class='strip__index num'>M</span>
        <span class='strip__name'>Master</span>
      </div>
      <div class='strip__slots'>
        {slots.map(({ id, plugin }) => (
          <span key={id} class='slot' data-hint={`${plugin.label}, in the master's chain`}>
            <i class='slot__dot' />
            <span class='slot__label'>{plugin.label}</span>
          </span>
        ))}
      </div>
      {slots.map((slot) => (
        <InstanceControls
          key={slot.id}
          owner={`Master ${slot.plugin.label.toLowerCase()}`}
          instance={slot}
          targetOf={(param) => HoldTarget.SlotParam({ slot: slot.id, param })}
        />
      ))}
      <StripControls owner='Master' insert={master} values={values} marks='numbered' meter={masterMeter} />
    </div>
  )
}

/** An insert by its number: M writes its mute, for everyone. */
const InsertStrip = ({ id, number }: { readonly id: Id; readonly number: number }) => {
  const { session, registry, ops } = useCore()
  const { strip: values, mute } = useAtomValue(session.project.insert(id))
  const owner = `Strip ${number}`
  return (
    <div class='strip' data-muted={mute} style={{ '--strip-w': `${stripWidth}px` }}>
      <div class='strip__head'>
        <span class='strip__index strip__index--insert num'>{number}</span>
        <button
          type='button'
          class='toggle toggle--shared'
          aria-label={`${owner}: mute`}
          aria-pressed={mute}
          data-hint={Boolean.match(mute, {
            onTrue: () => `${owner} is muted in the project, for everyone`,
            onFalse: () => `Mute ${owner.toLowerCase()} in the project, for everyone`
          })}
          // The document's mute now, which may be ahead of the one drawn.
          onClick={() => ops.setInsertMute(id, !registry.get(session.project.insert(id)).mute)}
        >
          M
        </button>
      </div>
      <StripControls owner={owner} insert={id} values={values} marks='bare' meter={number} />
    </div>
  )
}

// A strip and the gap after it, across, which its styles take from here: the rack lays them out by it, and draws only
// those in sight.
const stripWidth = 76
const stripGap = 4
const stripStep = stripWidth + stripGap

/** The first strip drawn, scrolled so far: a strip before the first in sight, so a scroll shows no gap before a draw. */
const firstDrawn = (left: number) =>
  Number.clamp(Math.floor(left / stripStep) - 1, { minimum: 0, maximum: insertCount })

/** Past the last strip drawn: those in sight from the first drawn, and a strip more. */
const endDrawn = (first: number, width: number) =>
  Number.clamp(first + Math.ceil(width / stripStep) + 2, { minimum: first, maximum: insertCount })

/**
 * The inserts besides the master, by their number, scrolled across from where the page last left them: drawn again only
 * once another comes into sight.
 */
const InsertRack = () => {
  const { registry, view } = useCore()
  const rack = useRef<HTMLDivElement>(null)
  const [first, setFirst] = useState(() => firstDrawn(registry.get(view.rackScroll)))
  useLayoutEffect(() => {
    Option.map(Option.fromNullishOr(rack.current), (shown) => {
      shown.scrollLeft = registry.get(view.rackScroll)
    })
  }, [registry, view])
  const width = Option.match(useLaidOutSize(rack), { onNone: () => 0, onSome: ({ width }) => width })
  const end = endDrawn(first, width)
  const onScroll = (left: number) => {
    registry.set(view.rackScroll, left)
    setFirst(firstDrawn(left))
  }
  return (
    <div class='rack' ref={rack} onScroll={(event) => onScroll(event.currentTarget.scrollLeft)}>
      <div
        class='rack__strips'
        style={{
          gap: `${stripGap}px`,
          width: `${insertCount * stripStep - stripGap}px`,
          paddingLeft: `${first * stripStep}px`
        }}
      >
        {mixerInserts.slice(first, end).map((id, i) => (
          <InsertStrip key={id} id={id} number={first + i + 1} />
        ))}
      </div>
    </div>
  )
}

/** The master, pinned, then the other inserts; the meters' lamps stay lit while the Mixer is in the middle. */
export const Mixer = () => {
  const board = useMemo(meterBoard, [])
  // Every frame, the strips out of sight too.
  useFrame(board.follow)
  return (
    <MeterBoardContext.Provider value={board}>
      <div class='mixer'>
        <MasterStrip />
        <InsertRack />
      </div>
    </MeterBoardContext.Provider>
  )
}
