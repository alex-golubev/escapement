import { type AnyParam, paramPosition } from '@escapement/engine-description'
import type { HoldTarget } from '@escapement/model'
import { useParamTurn } from './knob'
import './fader.css'

// Its sizes, which its styles take from here: the cap's travel is the drag from end to end.
const faderHeight = 168
const capHeight = 22
const travelPixels = faderHeight - capHeight

/** Where the scale marks a volume, in decibels; none for silence. */
const marks: ReadonlyArray<{ readonly decibels: number; readonly text: string }> = [
  { decibels: 5, text: '+5' },
  { decibels: 0, text: '0' },
  { decibels: -5, text: '−5' },
  { decibels: -10, text: '−10' },
  { decibels: -20, text: '−20' },
  { decibels: -30, text: '−30' }
]

const gainOf = (decibels: number) => 10 ** (decibels / 20)

/**
 * Its marks with their decibels, or bare: faders side by side on one line, the numbers of one serve the rest, which
 * leaves them room.
 */
export type FaderMarks = 'numbered' | 'bare'

/** Its marks in decibels, laid out along the cap's travel by the volume's own scale, so they can't drift from it. */
const Scale = ({ param, numbered }: { readonly param: AnyParam; readonly numbered: boolean }) => (
  <span class='fader-scale' data-numbered={numbered} aria-hidden='true'>
    <span class='fader-scale__inner'>
      {marks.map(({ decibels, text }) => (
        <span
          key={decibels}
          class='fader-scale__tick num'
          style={{ '--t': paramPosition(param, gainOf(decibels)) }}
          data-unity={decibels === 0}
        >
          {numbered && text}
        </span>
      ))}
      <span class='fader-scale__tick num' style={{ '--t': 0 }}>
        {numbered && '−∞'}
      </span>
    </span>
  </span>
)

/** A volume as a fader dragged up or down, its scale beside it. `owner` names whose volume it is, such as the insert. */
export const Fader = ({
  owner,
  param,
  value,
  target,
  marks
}: {
  readonly owner: string
  readonly param: AnyParam
  readonly value: number
  readonly target: HoldTarget
  readonly marks: FaderMarks
}) => {
  const { turned, text, hint } = useParamTurn(owner, param, value, target, travelPixels)
  return (
    <span class='fader-with-scale' style={{ '--fader-h': `${faderHeight}px`, '--cap-h': `${capHeight}px` }}>
      <span
        class='fader'
        role='slider'
        tabIndex={0}
        aria-label={`${owner}: ${param.label.toLowerCase()}`}
        aria-valuemin={param.min}
        aria-valuemax={param.max}
        aria-valuenow={turned.value}
        aria-valuetext={text}
        style={{ '--v': paramPosition(param, turned.value) }}
        data-hint={hint}
        {...turned.pointer}
        {...turned.keys}
      >
        <span class='fader__track' />
        <span class='fader__travel'>
          <span class='fader__fill' />
          <span class='fader__cap' />
        </span>
      </span>
      <Scale param={param} numbered={marks === 'numbered'} />
    </span>
  )
}
