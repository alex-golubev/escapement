import { useAtomValue } from '@effect/atom-react'
import { defaultTempo, maxTempo, minTempo } from '@escapement/engine-description'
import { HoldTarget } from '@escapement/model'
import { Number } from 'effect'
import { useCore } from '../../core-context'
import { type TurnScale, useTurnGesture } from '../../parts/turn-gesture'

const tempo = HoldTarget.Tempo()

/** Whole BPM, 3 pixels each, not a knob's 2.5 BPM a pixel; with Shift, hundredths, a pixel each. */
const scale: TurnScale = {
  units: (bpm) => bpm,
  value: Math.round,
  range: { minimum: minTempo, maximum: maxTempo },
  pixelsPerUnit: 3,
  fine: { pixelsPerUnit: 100, value: (bpm) => Number.round(bpm, 2) },
  step: 1,
  default: defaultTempo
}

/** As the field shows it, to the hundredth. */
const shownTempo = (bpm: number) => bpm.toFixed(2)

/** The tempo as a number dragged up or down, BPM beside it in its frame. */
export const TempoField = () => {
  const { session } = useCore()
  const turned = useTurnGesture(tempo, useAtomValue(session.project.tempo), scale)
  const shown = shownTempo(turned.value)
  return (
    <span
      role='spinbutton'
      class='field tempo'
      tabIndex={0}
      aria-label='Tempo'
      aria-valuemin={minTempo}
      aria-valuemax={maxTempo}
      aria-valuenow={turned.value}
      aria-valuetext={`${shown} BPM`}
      data-hint={`Tempo ${shown} BPM: in the project. Drag up or down, Shift for hundredths, double-click for ${shownTempo(defaultTempo)}`}
      {...turned.pointer}
      {...turned.keys}
    >
      <span class='field__name' aria-hidden='true'>
        BPM
      </span>
      <span class='field__value'>{shown}</span>
    </span>
  )
}
