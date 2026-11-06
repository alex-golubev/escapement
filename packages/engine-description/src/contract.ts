// What the build thread checks the engine against as it starts, so this module loads no package, Effect included.

export { descriptionsFingerprint } from './catalog/descriptions'

/** Time is whole ticks, this many to a quarter note. */
export const ticksPerQuarter = 960

/** Quarter notes a minute; the engine clamps a tempo past these. */
export const minTempo = 10
export const maxTempo = 522
/** What a new engine plays at until it is sent a tempo. */
export const defaultTempo = 120

/** MIDI's: the engine holds a key in one byte and refuses one past the highest. */
export const lowestKey = 0
export const highestKey = 127

/** How hard a note is played; the engine clamps a velocity past these. */
export const minVelocity = 0
export const maxVelocity = 1
