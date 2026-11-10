import { ticksPerQuarter } from '@escapement/engine-description'
import { barTicks } from '@escapement/model'
import { useRef } from 'preact/hooks'
import { heardOf, setText, useFrame } from '../../parts/frames'

const padded = (value: number, digits: number) => String(value).padStart(digits, '0')

/** Where a tick of the arrangement is, from 1: its bar, three digits; its beat, two; its tick in the beat, three. */
export const positionText = (tick: number) => {
  const whole = Math.floor(tick)
  return {
    bar: padded(Math.floor(whole / barTicks) + 1, 3),
    beat: padded(Math.floor((whole % barTicks) / ticksPerQuarter) + 1, 2),
    tick: padded(whole % ticksPerQuarter, 3)
  }
}

/** How long into the arrangement a tick is at the tempo: minutes, seconds and milliseconds, as `00:32.480`. */
export const timeText = (tick: number, tempo: number) => {
  const milliseconds = Math.floor((tick * 60_000) / (tempo * ticksPerQuarter))
  const seconds = Math.floor(milliseconds / 1000)
  return `${padded(Math.floor(seconds / 60), 2)}:${padded(seconds % 60, 2)}.${padded(milliseconds % 1000, 3)}`
}

/** Where the arrangement is heard, in bars and in time, written into the DOM every frame; stopped, where Play starts. */
export const Clock = () => {
  const bar = useRef<HTMLSpanElement>(null)
  const beat = useRef<HTMLSpanElement>(null)
  const beatTick = useRef<HTMLSpanElement>(null)
  const time = useRef<HTMLSpanElement>(null)
  useFrame((frame) => {
    const { tick, tempo } = heardOf(frame)
    const position = positionText(tick)
    setText(bar.current, position.bar)
    setText(beat.current, position.beat)
    setText(beatTick.current, position.tick)
    setText(time.current, timeText(tick, tempo))
  })
  // Before any frame: where a new engine stands.
  const standing = heardOf(undefined)
  const start = positionText(standing.tick)
  return (
    <>
      <span
        role='timer'
        class='field field--readout'
        aria-label='Position'
        data-hint='Position: the bar, the beat and the tick heard, or where Play starts. Only yours: each tab plays on its own'
      >
        <span class='field__name' aria-hidden='true'>
          BAR
        </span>
        <span ref={bar}>{start.bar}</span>
        <span class='field__dot'>.</span>
        <span ref={beat}>{start.beat}</span>
        <span class='field__dot'>.</span>
        <span class='field__fine' ref={beatTick}>
          {start.tick}
        </span>
      </span>
      <span
        role='timer'
        class='field field--readout time'
        aria-label='Time'
        data-hint="Time: how far into the arrangement the position is, at the project's tempo"
      >
        <span class='field__name' aria-hidden='true'>
          TIME
        </span>
        <span class='field__value' ref={time}>
          {timeText(standing.tick, standing.tempo)}
        </span>
      </span>
    </>
  )
}
