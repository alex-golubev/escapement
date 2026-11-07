import type { Tick } from '@escapement/engine-description'
import { Array, Boolean, Option, Order } from 'effect'
import type { Atom } from 'effect/reactivity'
import { byContent, type ProjectAtoms } from './atoms'
import type { Id } from './id'
import type { Track } from './project'
import { arrangementEnd, startInRound } from './time'

/** How this client listens to the project: its own, never in the document. */
export interface Listening {
  /** The tracks in solo, by ID in order; one deleted counts again once it is back. */
  readonly solo: ReadonlyArray<Id>
}

/** As a client starts to listen: no track in solo. */
export const newListening: Listening = { solo: [] }

/** Into solo if it wasn't, out if it was. */
export const toggledSolo = ({ solo, ...rest }: Listening, track: Id): Listening => ({
  ...rest,
  solo: Boolean.match(solo.includes(track), {
    onTrue: () => solo.filter((id) => id !== track),
    onFalse: () => Array.sort([...solo, track], Order.String)
  })
})

/**
 * The tracks heard, in their order: while any of them is in solo, exactly those in solo, muted in the document or not;
 * otherwise each one not muted. Only the tracks given count, so one deleted in solo doesn't.
 */
export const heardTracks = (tracks: ReadonlyArray<Track>, { solo }: Listening): ReadonlyArray<Id> => {
  const soloed = tracks.filter(({ id }) => solo.includes(id))
  return Array.match(soloed, {
    onEmpty: () => tracks.filter(({ mute }) => !mute),
    onNonEmpty: (soloed) => soloed
  }).map(({ id }) => id)
}

/** The tracks heard as the project and the listening change; what draws a track and what builds it agree. */
export const heardOf = (project: ProjectAtoms, listening: Atom.Atom<Listening>): Atom.Atom<ReadonlyArray<Id>> =>
  byContent((get) =>
    heardTracks(
      get(project.trackIds).flatMap((id) => Option.toArray(get(project.track(id)))),
      get(listening)
    )
  )

/** A clip as Play plays it: its pattern on its track, from a tick of the loop, for its length. */
export interface PlayedClip {
  readonly tick: Tick
  readonly track: Id
  readonly pattern: Id
  /** Ticks, from 1. */
  readonly length: number
  /** Ticks, from 1: its pattern's `patternEnd`, as the pattern starts again every so many. */
  readonly period: number
  /** Ticks into a round of its pattern it starts at, under its period. */
  readonly offset: number
}

/** What Play plays, and how long before it goes round again. */
export interface Played {
  readonly clips: ReadonlyArray<PlayedClip>
  /** Ticks, from 1. */
  readonly end: number
}

/**
 * What Play plays as the project changes: the arrangement's clips, round and round `arrangementEnd`. What draws it and
 * what builds it agree.
 */
export const playedOf = (project: ProjectAtoms): Atom.Atom<Played> =>
  byContent((get) => {
    const clips = get(project.arrangementClips).map(({ tick, track, pattern, length, period, offset }) => ({
      tick,
      track,
      pattern,
      length,
      period,
      offset: startInRound(offset, period)
    }))
    return { clips, end: arrangementEnd(clips) }
  })
