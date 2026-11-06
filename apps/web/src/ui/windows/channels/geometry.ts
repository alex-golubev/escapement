import { ticksPerQuarter } from '@escapement/engine-description'
import { barSteps, barTicks, stepBars, stepTicks } from '@escapement/model'
import type { Lane } from '../../parts/follow'
import { barGap, beatGap, stepGap, stepWidth } from './layout'

/** The steps of a beat. */
export const beatSteps = ticksPerQuarter / stepTicks

const beatWidth = beatSteps * stepWidth + (beatSteps - 1) * stepGap

const barBeats = barSteps / beatSteps

/** A bar of steps, across. */
export const barWidth = barBeats * beatWidth + (barBeats - 1) * beatGap

/** The steps of so many bars, across. */
export const stepsWidth = (bars: number) => bars * barWidth + (bars - 1) * barGap

/** Where a tick lies across the steps, from the first one's left edge: a step's ticks go across its pad, a gap has none. */
export const xOf = (tick: number) => {
  const bar = Math.floor(tick / barTicks)
  const beat = Math.floor((tick % barTicks) / ticksPerQuarter)
  const step = Math.floor((tick % ticksPerQuarter) / stepTicks)
  return (
    bar * (barWidth + barGap) +
    beat * (beatWidth + beatGap) +
    step * (stepWidth + stepGap) +
    ((tick % stepTicks) / stepTicks) * stepWidth
  )
}

/** Where what lasts to the tick ends across the steps: on a step's start, at the right edge of the pad before it. */
export const endOf = (tick: number) => xOf(tick - 1) + stepWidth / stepTicks

/** How many whole bars of steps fit across so many pixels. */
export const barsAcross = (width: number) => Math.floor((width + barGap) / (barWidth + barGap))

/**
 * The bars of steps shown: the pattern's, one past its end to put steps in, and as many more as fit; no more than the
 * step sequencer has.
 */
export const barsShown = (patternBars: number, fit: number) => Math.min(Math.max(patternBars + 1, fit), stepBars)

/** The steps as the pattern's time across a Channels window scrolled so far, so wide in sight right of the names. */
export const laneOf = (left: number, width: number): Lane => ({ left, width, xOf })
