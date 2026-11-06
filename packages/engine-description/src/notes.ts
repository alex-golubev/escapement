import { Brand } from 'effect'
import { highestKey, lowestKey } from './contract'

/** A point in musical time: a whole number of ticks from the start, as many to a quarter note as `ticksPerQuarter`. */
export type Tick = Brand.Branded<number, 'Tick'>

/** The engine holds a tick in 32 bits. */
export const lastTick = 0xffff_ffff

/** Throws on anything else. */
export const Tick = Brand.make<Tick>(
  (tick) => (Number.isInteger(tick) && tick >= 0 && tick <= lastTick) || `not a tick: ${tick}`
)

/** A MIDI key: a whole number from `lowestKey` to `highestKey`; 60 is middle C. */
export type MidiKey = Brand.Branded<number, 'MidiKey'>

/** Throws on anything else. */
export const MidiKey = Brand.make<MidiKey>(
  (key) => (Number.isInteger(key) && key >= lowestKey && key <= highestKey) || `not a MIDI key: ${key}`
)
