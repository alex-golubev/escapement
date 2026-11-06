import { Tick } from '@escapement/engine-description'
import { Array, Boolean, Option, Order } from 'effect'
import type { Atom } from 'effect/reactivity'
import { byContent, type ProjectAtoms } from './atoms'
import type { Id } from './id'
import type { Channel, Pattern, PatternPlace } from './project'
import { arrangementEnd, barTicks, startInRound } from './steps'

/** What Play plays: the current pattern on its own, or the arrangement. */
export const playModes = ['pattern', 'arrangement'] as const

export type PlayMode = (typeof playModes)[number]

/** How this client listens to the project: its own, never in the document. */
export interface Listening {
  /** The channels in solo, by ID in order; one deleted counts again once it is back. */
  readonly solo: ReadonlyArray<Id>
  /** The pattern chosen; while it isn't live, the one `currentPattern` finds near it. */
  readonly pattern: Option.Option<Id>
  readonly mode: PlayMode
}

/** As a client starts to listen: no channel in solo, the first pattern current, and that pattern played. */
export const newListening: Listening = { solo: [], pattern: Option.none(), mode: 'pattern' }

const otherMode: Record<PlayMode, PlayMode> = { pattern: 'arrangement', arrangement: 'pattern' }

/** Pattern if it was Arrangement, Arrangement if it was Pattern, as L switches. */
export const toggledMode = (listening: Listening): Listening => ({ ...listening, mode: otherMode[listening.mode] })

/** Into solo if it wasn't, out if it was. */
export const toggledSolo = ({ solo, ...rest }: Listening, channel: Id): Listening => ({
  ...rest,
  solo: Boolean.match(solo.includes(channel), {
    onTrue: () => solo.filter((id) => id !== channel),
    onFalse: () => Array.sort([...solo, channel], Order.String)
  })
})

/**
 * The channels heard, in their order: while any of them is in solo, exactly those in solo, muted in the document or
 * not; otherwise each one not muted. Only the channels given count, so one deleted in solo doesn't.
 */
export const heardChannels = (channels: ReadonlyArray<Channel>, { solo }: Listening): ReadonlyArray<Id> => {
  const soloed = channels.filter(({ id }) => solo.includes(id))
  return Array.match(soloed, {
    onEmpty: () => channels.filter(({ mute }) => !mute),
    onNonEmpty: (soloed) => soloed
  }).map(({ id }) => id)
}

/** The channels heard as the project and the listening change; what draws a channel and what builds it agree. */
export const heardOf = (project: ProjectAtoms, listening: Atom.Atom<Listening>): Atom.Atom<ReadonlyArray<Id>> =>
  byContent((get) =>
    heardChannels(
      get(project.channelIds).flatMap((id) => Option.toArray(get(project.channel(id)))),
      get(listening)
    )
  )

/**
 * The pattern seen and played: the one chosen while it is live; once it is deleted, the first live one after it, or
 * else the last before it, so a deletion goes on to its neighbour; with none chosen, or one never there, the first.
 * The chosen one back, by an undo, is current again. None without a live pattern.
 */
export const currentPattern = (places: ReadonlyArray<PatternPlace>, { pattern }: Listening): Option.Option<Id> => {
  const live = ({ live }: PatternPlace) => live
  return Option.map(
    Option.orElse(
      Option.flatMap(
        Option.flatMap(pattern, (chosen) => Array.findFirstIndex(places, ({ id }) => id === chosen)),
        (at) => Option.orElse(Array.findFirst(places.slice(at), live), () => Array.findLast(places.slice(0, at), live))
      ),
      () => Array.findFirst(places, live)
    ),
    ({ id }) => id
  )
}

/** The current pattern as the project and the listening change: what draws it and what builds it agree. */
export interface CurrentPattern {
  readonly id: Atom.Atom<Option.Option<Id>>
  readonly pattern: Atom.Atom<Option.Option<Pattern>>
  /** How long it plays: `patternEnd`, a bar without one. */
  readonly end: Atom.Atom<number>
}

export const currentPatternOf = (project: ProjectAtoms, listening: Atom.Atom<Listening>): CurrentPattern => {
  const id = byContent((get) => currentPattern(get(project.patternPlaces), get(listening)))
  return {
    id,
    pattern: byContent((get) => Option.flatMap(get(id), (current) => get(project.pattern(current)))),
    end: byContent((get) =>
      Option.match(get(id), { onNone: () => barTicks, onSome: (current) => get(project.patternEnd(current)) })
    )
  }
}

/**
 * A pattern played from a tick of the loop, for its length: a clip of the arrangement's, or the current pattern alone.
 */
export interface PlayedClip {
  readonly tick: Tick
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
 * What Play plays as the project and the listening change: in Pattern mode the current pattern from the start, round
 * and round its length, none without one; in Arrangement mode the arrangement's clips of live patterns, round and round
 * `arrangementEnd`. What draws it and what builds it agree.
 */
export const playedOf = (
  project: ProjectAtoms,
  listening: Atom.Atom<Listening>,
  current: CurrentPattern = currentPatternOf(project, listening)
): Atom.Atom<Played> => {
  const modes: Record<PlayMode, Atom.Atom<Played>> = {
    pattern: byContent((get) => ({
      clips: Option.toArray(
        Option.map(get(current.id), (pattern) => ({
          tick: Tick(0),
          pattern,
          length: get(current.end),
          period: get(current.end),
          offset: 0
        }))
      ),
      end: get(current.end)
    })),
    arrangement: byContent((get) => {
      const clips = get(project.arrangementClips).map(({ tick, pattern, length, period, offset }) => ({
        tick,
        pattern,
        length,
        period,
        offset: startInRound(offset, period)
      }))
      return { clips, end: arrangementEnd(clips) }
    })
  }
  return byContent((get) => get(modes[get(listening).mode]))
}
