import {
  type AnyParam,
  formatShort,
  formatValue,
  paramPosition,
  paramValue,
  widestShort,
  widestText
} from '@escapement/engine-description'
import type { HoldTarget } from '@escapement/model'
import { Boolean } from 'effect'
import { type TurnScale, useTurnGesture } from './turn-gesture'
import './knob.css'

/** A knob goes from its lowest position to its highest over this many pixels. */
const knobPixels = 200

/** Lowest to highest over `pixels`, with Shift over ten times as many; a key a hundredth, or of whole numbers, one. */
const scaleOf = (param: AnyParam, pixels: number): TurnScale => ({
  units: (value) => paramPosition(param, value),
  value: (position) => paramValue(param, position),
  range: { minimum: 0, maximum: 1 },
  pixelsPerUnit: pixels,
  fine: { pixelsPerUnit: 10 * pixels, value: (position) => paramValue(param, position) },
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

type ParamTurn = ReturnType<typeof useParamTurn>

/** A control turned as a knob is, to the browser: a slider of the parameter, which a drag and its keys turn. */
const sliderOf = (label: string, param: AnyParam, { turned, text, hint }: ParamTurn) => ({
  role: 'slider' as const,
  tabIndex: 0,
  'aria-label': label,
  'aria-valuemin': param.min,
  'aria-valuemax': param.max,
  'aria-valuenow': turned.value,
  'aria-valuetext': text,
  'data-hint': hint,
  ...turned.pointer,
  ...turned.keys
})

/** The dial itself: a cap, its mark turned to the position. */
const Dial = ({
  label,
  param,
  knob
}: {
  readonly label: string
  readonly param: AnyParam
  readonly knob: ParamTurn
}) => (
  <span class='knob' style={{ '--v': paramPosition(param, knob.turned.value) }} {...sliderOf(label, param, knob)}>
    <span class='knob__hand' />
  </span>
)

/**
 * A parameter's knob, its number under it, which a drag turns too, then its name. `owner` names whose parameter it is,
 * such as the track.
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
        class='param__value'
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

/** A parameter's value alone, short, turned as a knob is, for a narrow place: in full in the hint and when read out. */
export const ParamText = ({
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
    <span
      class='param-text num'
      style={{ '--chars': widestShort(param) }}
      {...sliderOf(`${owner}: ${param.label.toLowerCase()}`, param, knob)}
    >
      {formatShort(param, knob.turned.value)}
    </span>
  )
}
