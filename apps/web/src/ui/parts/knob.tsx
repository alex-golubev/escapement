import { type AnyParam, formatValue, paramPosition, paramValue, widestText } from '@escapement/engine-description'
import type { HoldTarget } from '@escapement/model'
import { Boolean } from 'effect'
import { type TurnScale, useTurnGesture } from './turn-gesture'
import './knob.css'

/** A knob goes from its lowest position to its highest over this many pixels. */
const knobPixels = 200

/**
 * On the parameter's scale, from its lowest position to its highest over `pixels`, a key press a hundredth, or of
 * whole numbers, one.
 */
const scaleOf = (param: AnyParam, pixels: number): TurnScale => ({
  units: (value) => paramPosition(param, value),
  value: (position) => paramValue(param, position),
  range: { minimum: 0, maximum: 1 },
  pixelsPerUnit: pixels,
  step: Boolean.match(param.whole, { onTrue: () => paramPosition(param, param.min + 1), onFalse: () => 0.01 }),
  default: param.default
})

/**
 * What a control of a parameter shows and how it turns, as a knob or a fader, with the value that plays: the
 * document's, or the one held while it turns.
 */
export const useParamTurn = (
  owner: string,
  param: AnyParam,
  value: number,
  target: HoldTarget,
  pixels: number = knobPixels
) => {
  const turned = useTurnGesture(target, value, scaleOf(param, pixels))
  const text = formatValue(param, turned.value)
  const hint = `${owner} ${param.label.toLowerCase()} ${text}: in the project. Drag up or down, Shift for fine, double-click for the default`
  return { turned, text, hint }
}

const useKnob = (owner: string, param: AnyParam, value: number, target: HoldTarget) =>
  useParamTurn(owner, param, value, target)

/** The dial itself, filled from where the parameter's zero stands: from the start, or from the middle for a pan. */
const Dial = ({
  label,
  param,
  knob: { turned, text, hint }
}: {
  readonly label: string
  readonly param: AnyParam
  readonly knob: ReturnType<typeof useKnob>
}) => (
  <span
    class='knob'
    role='slider'
    tabIndex={0}
    aria-label={label}
    aria-valuemin={param.min}
    aria-valuemax={param.max}
    aria-valuenow={turned.value}
    aria-valuetext={text}
    style={{ '--v': paramPosition(param, turned.value), '--zero': paramPosition(param, 0) }}
    data-hint={hint}
    {...turned.pointer}
    {...turned.keys}
  >
    <span class='knob__arc' />
    <span class='knob__body' />
    <span class='knob__hand' />
  </span>
)

/**
 * A parameter's knob, its number under it, which a drag turns too, then its name. `owner` names whose parameter it is,
 * such as the channel.
 */
export const Knob = ({
  owner,
  param,
  value,
  target
}: {
  readonly owner: string
  readonly param: AnyParam
  readonly value: number
  readonly target: HoldTarget
}) => {
  const knob = useKnob(owner, param, value, target)
  return (
    <span class='param'>
      <Dial label={param.label} param={param} knob={knob} />
      {/* The knob's value as it reads it out; a drag on it turns the knob, the keys stay with the knob. */}
      <span
        class='field num'
        aria-hidden='true'
        style={{ '--chars': widestText(param) }}
        data-hint={knob.hint}
        {...knob.turned.pointer}
      >
        {knob.text}
      </span>
      <span class='cap'>{param.label}</span>
    </span>
  )
}

/** A knob without its name and number, as on a channel's row, where the hint reads them out. */
export const SmallKnob = ({
  owner,
  param,
  value,
  target
}: {
  readonly owner: string
  readonly param: AnyParam
  readonly value: number
  readonly target: HoldTarget
}) => {
  const knob = useKnob(owner, param, value, target)
  return <Dial label={`${owner}: ${param.label.toLowerCase()}`} param={param} knob={knob} />
}
