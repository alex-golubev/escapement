import type { MidiKey, Sha256, StripValues, Tick } from '@escapement/engine-description'
import { Option } from 'effect'
import * as Y from 'yjs'
import { Id } from './id'

declare const holds: unique symbol

/**
 * A map of the document that holds `F`: written as `F` says, but read as anything, since other clients, other versions
 * and bugs write to it too.
 */
export type Stored<F> = Y.Map<unknown> & { readonly [holds]: F }

/** The one place a map becomes one the layout describes. */
const stored = <F>(map: Y.Map<unknown>): Stored<F> => map as Stored<F>

export type Key<F> = keyof F & string

/** As found: reading decides what to make of it. */
export const get = <F, K extends Key<F>>(map: Stored<F>, key: K): unknown => map.get(key)

export const set = <F, K extends Key<F>>(map: Stored<F>, key: K, value: F[K]) => {
  map.set(key, value)
}

export const remove = <F, K extends Key<F>>(map: Stored<F>, key: K) => {
  map.delete(key)
}

/** The map the layout puts under `key`, unless something else is there. */
export const mapAt = <F, K extends Key<F>>(map: Stored<F>, key: K): Option.Option<F[K] & Y.Map<unknown>> => {
  const found = map.get(key)
  return Option.liftPredicate(found, (found): found is F[K] & Y.Map<unknown> => found instanceof Y.Map)
}

/** In no particular order: each client keeps its own. */
export const idsOf = <F>(map: Stored<Record<string, F>>): ReadonlyArray<Id> => Array.from(map.keys(), Id)

/** A new map with these fields, to set into the document. */
export const newMap = <F extends object>(fields: F): Stored<F> => stored(new Y.Map(Object.entries(fields)))

export interface MetaFields {
  /** Made with the project: two documents with one hold the same project. Projects made before it have none. */
  readonly id: Id
  readonly bpm: number
}

/** A plugin and its state: a track's instrument or a slot of the master's. Each parameter merges on its own. */
export interface PluginFields {
  readonly plugin: { readonly id: number; readonly version: number }
  /** By parameter ID; one left out is at its default. */
  readonly params: Stored<Record<string, number>>
  /** By sample ID; one left out has no sound. */
  readonly samples: Stored<Record<string, Sha256>>
}

/** Its strip's parameters by ID, each a key of its own; one left out is at its default. */
export interface TrackFields extends Partial<StripValues> {
  readonly name: string
  /** A fractional index: tracks sort by it. */
  readonly order: string
  readonly deleted: boolean
  readonly mute: boolean
  readonly instrument: Stored<PluginFields>
}

/** One value: a note changes as a whole. */
export interface NoteFields {
  readonly tick: Tick
  /** Whole ticks, from 1. */
  readonly len: number
  readonly key: MidiKey
  /** From 0 to 1. */
  readonly vel: number
}

/** One value: where a clip starts, how long it plays and, later, what part of its pattern change together. */
export interface ClipBounds {
  readonly tick: Tick
  /** Ticks, from 1; none while the clip is as long as its pattern. */
  readonly length?: number
  /** Ticks into its pattern's rounds the clip starts at, as `Clip` has it; none from a round's start. */
  readonly offset?: number
}

/** Notes on a track of the arrangement, played by the track's instrument. */
export interface ClipFields {
  /** By ID. */
  readonly track: Id
  readonly bounds: ClipBounds
  /** Where its notes are, by ID: a map of their own at the document's top, `patternNotes`. */
  readonly pattern: Id
  readonly deleted: boolean
}

export interface SlotFields extends PluginFields {
  readonly order: string
  readonly deleted: boolean
}

/** Its strip's parameters by ID, each a key of its own; one left out is at its default. */
export interface MasterFields extends Partial<StripValues> {
  /** Its plugins after what it hears. */
  readonly slots: Stored<Record<string, Stored<SlotFields>>>
}

/** The project's top-level maps: one project a document. The master is built in, so clients share its map. */
export const projectMaps = (doc: Y.Doc) => ({
  meta: stored<MetaFields>(doc.getMap('meta')),
  tracks: stored<Record<string, Stored<TrackFields>>>(doc.getMap('tracks')),
  clips: stored<Record<string, Stored<ClipFields>>>(doc.getMap('clips')),
  master: stored<MasterFields>(doc.getMap('master'))
})

export type ProjectMaps = ReturnType<typeof projectMaps>

const notesPrefix = 'notes/'

/** The name of the top-level map of the pattern's notes. */
export const notesName = (pattern: Id) => `${notesPrefix}${pattern}`

/** The pattern whose notes the top-level map of this name holds; none for a map of anything else. */
export const notesPattern = (name: string): Option.Option<Id> =>
  Option.map(
    Option.liftPredicate(name, (name) => name.startsWith(notesPrefix) && name.length > notesPrefix.length),
    (name) => Id(name.slice(notesPrefix.length))
  )

/**
 * The pattern's notes by ID, a map of the document's top: no write puts anything else in its place, and two clients
 * that write into it first share it, so it never needs mending. Taking it writes nothing. A pattern is only its notes:
 * it is there while a clip names it.
 */
export const patternNotes = (doc: Y.Doc, pattern: Id): Stored<Record<string, NoteFields>> =>
  stored(doc.getMap(notesName(pattern)))
