import { Array, Option, Record } from 'effect'
import { Id } from './id'

/** The tracks there are, built in: none are added. */
export const trackCount = 500

/**
 * The arrangement's tracks, in their order: built in, each with an ID of its own, so a track moved later takes its
 * clips with it. The document holds nothing of a track until it has something of its own.
 */
export const arrangementTracks: ReadonlyArray<Id> = Array.makeBy(trackCount, (i) => Id(String(i + 1)))

const places: Readonly<Record<string, number>> = Record.fromEntries(arrangementTracks.map((id, i) => [id, i]))

/** Where the track stands among them, from 0; none for an ID that names none. */
export const trackPlace = (track: string): Option.Option<number> => Record.get(places, track)
