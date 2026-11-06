import { useAtomValue } from '@effect/atom-react'
import { defaultTempo, maxTempo, minTempo } from '@escapement/engine-description'
import { HoldTarget } from '@escapement/model'
import { useCore } from '../../core-context'
import { type TurnScale, useTurnGesture } from '../../parts/turn-gesture'

const tempo = HoldTarget.Tempo()

/**
 * Whole BPM over the engine's range, 3 pixels each (over a knob's 200 pixels it would move 2.5 BPM a pixel), a key
 * press one, a double click the engine's default.
 */
const scale: TurnScale = {
  units: (bpm) => bpm,
  value: Math.round,
  range: { minimum: minTempo, maximum: maxTempo },
  pixelsPerUnit: 3,
  step: 1,
  default: defaultTempo
}

/** The tempo as a number dragged up or down. */
export const TempoField = () => {
  const { session } = useCore()
  const turned = useTurnGesture(tempo, useAtomValue(session.project.tempo), scale)
  return (
    <span
      role='spinbutton'
      class='field num'
      tabIndex={0}
      aria-label='Tempo'
      aria-valuemin={minTempo}
      aria-valuemax={maxTempo}
      aria-valuenow={turned.value}
      data-hint={`Tempo ${turned.value} BPM: in the project. Drag up or down, Shift for fine, double-click for ${defaultTempo}`}
      {...turned.pointer}
      {...turned.keys}
    >
      {turned.value}
    </span>
  )
}
