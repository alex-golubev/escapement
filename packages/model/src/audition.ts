import type { MidiKey } from '@escapement/engine-description'
import type { Id } from './id'

/**
 * A note this client plays by hand to hear it, from the press to the release, its own and never in the document: a key
 * of the piano roll held, or a note held there. `press` tells it from every other this client plays.
 */
export interface Audition {
  readonly track: Id
  readonly key: MidiKey
  readonly velocity: number
  readonly press: number
}

export type Auditions = ReadonlyArray<Audition>

export const noAuditions: Auditions = []
