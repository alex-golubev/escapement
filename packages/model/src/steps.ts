import { lastTick, MidiKey, maxVelocity, ticksPerQuarter } from '@escapement/engine-description'
import type { Note } from './project'

/** A step of the step sequencer is a sixteenth note. */
export const stepTicks = ticksPerQuarter / 4

/** The steps in a bar. */
export const barSteps = 16

/** A bar, in ticks. */
export const barTicks = barSteps * stepTicks

/** The most bars the step sequencer has, 512 steps: notes past them are the piano roll's. */
export const stepBars = 32

/** The longest a pattern or an arrangement plays: the whole bars a loop of the engine's ticks holds. */
const longestLoop = Math.floor(lastTick / barTicks) * barTicks

/** To the end of the bar of the last of these to end, a bar at least. */
const endOfBars = (parts: ReadonlyArray<{ readonly tick: number; readonly length: number }>) => {
  const last = parts.reduce((last, { tick, length }) => Math.max(last, tick + length), 0)
  return Math.min(Math.max(Math.ceil(last / barTicks), 1) * barTicks, longestLoop)
}

/**
 * How long a pattern of these notes plays: to the end of the last bar any of them sounds in, a bar at least.
 */
export const patternEnd = (notes: ReadonlyArray<Pick<Note, 'tick' | 'length'>>) => endOfBars(notes)

/**
 * How long an arrangement of these clips plays before it goes round again: to the end of the last one's bar, a bar at
 * least.
 */
export const arrangementEnd = (clips: ReadonlyArray<{ readonly tick: number; readonly length: number }>) =>
  endOfBars(clips)

/** Where in a round of its pattern a clip starts: its offset taken round its pattern's length, from 0. */
export const startInRound = (offset: number, period: number) => ((offset % period) + period) % period

/** What a step switched on plays: middle C, as long as the step, at full strength. */
export const stepNote = { key: MidiKey(60), length: stepTicks, velocity: maxVelocity }

/** A note a step switched on would make: middle C, a step long, starting on a step of the step sequencer's bars. */
export const isStepNote = ({ tick, length, key }: Pick<Note, 'tick' | 'length' | 'key'>) =>
  key === stepNote.key && length === stepNote.length && tick % stepTicks === 0 && tick < stepBars * barTicks
