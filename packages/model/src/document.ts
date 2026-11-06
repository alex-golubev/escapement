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

/** A plugin and its state: a channel's instrument or an insert's slot. Each parameter merges on its own. */
export interface PluginFields {
  readonly plugin: { readonly id: number; readonly version: number }
  /** By parameter ID; one left out is at its default. */
  readonly params: Stored<Record<string, number>>
  /** By sample ID; one left out has no sound. */
  readonly samples: Stored<Record<string, Sha256>>
}

/** Its strip's parameters by ID, each a key of its own; one left out is at its default. */
export interface ChannelFields extends Partial<StripValues> {
  readonly name: string
  /** A fractional index: channels sort by it. */
  readonly order: string
  readonly deleted: boolean
  readonly mute: boolean
  readonly instrument: Stored<PluginFields>
  /** The mixer's insert it goes into, by ID; none, the master. */
  readonly insert?: Id
}

/** One value: a note changes as a whole. */
export interface NoteFields {
  readonly channel: Id
  readonly tick: Tick
  /** Whole ticks, from 1. */
  readonly len: number
  readonly key: MidiKey
  /** From 0 to 1. */
  readonly vel: number
}

/** Its notes are a map of their own at the document's top: `patternNotes`. */
export interface PatternFields {
  readonly name: string
  /** A fractional index: patterns sort by it. */
  readonly order: string
  readonly deleted: boolean
}

/** One value: where a clip starts, how long it plays and, later, what part of its pattern change together. */
export interface ClipBounds {
  readonly tick: Tick
  /** Ticks, from 1; none while the clip is as long as its pattern. */
  readonly length?: number
  /** Ticks into its pattern's rounds the clip starts at, as `Clip` has it; none from a round's start. */
  readonly offset?: number
}

/** A pattern placed on a track of the arrangement. */
export interface ClipFields {
  /** One of the arrangement's tracks, by ID: `arrangementTracks`. */
  readonly track: Id
  readonly bounds: ClipBounds
  readonly pattern: Id
  readonly deleted: boolean
}

export interface SlotFields extends PluginFields {
  readonly order: string
  readonly deleted: boolean
}

/** Its strip's parameters by ID, each a key of its own; one left out is at its default. */
export interface InsertFields extends Partial<StripValues> {
  /** The master has none. */
  readonly mute?: boolean
  /** The master's plugins after what it hears; the other inserts have none yet. */
  readonly slots: Stored<Record<string, Stored<SlotFields>>>
}

/** The project's top-level maps: a document holds one project. */
export const projectMaps = (doc: Y.Doc) => ({
  meta: stored<MetaFields>(doc.getMap('meta')),
  channels: stored<Record<string, Stored<ChannelFields>>>(doc.getMap('channels')),
  patterns: stored<Record<string, Stored<PatternFields>>>(doc.getMap('patterns')),
  clips: stored<Record<string, Stored<ClipFields>>>(doc.getMap('clips'))
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
 * that write into it first share it, so it never needs mending. Taking it writes nothing.
 */
export const patternNotes = (doc: Y.Doc, pattern: Id): Stored<Record<string, NoteFields>> =>
  stored(doc.getMap(notesName(pattern)))

const insertPrefix = 'mixer/'

/** The name of the top-level map of the insert's own. */
export const insertName = (insert: Id) => `${insertPrefix}${insert}`

/** The insert whose own the top-level map of this name holds, any ID; none for a map of anything else. */
export const insertNamed = (name: string): Option.Option<Id> =>
  Option.map(
    Option.liftPredicate(name, (name) => name.startsWith(insertPrefix) && name.length > insertPrefix.length),
    (name) => Id(name.slice(insertPrefix.length))
  )

/**
 * The insert's own, a map of the document's top, as a pattern's notes are: the inserts are built in, so the first two
 * clients to write into one share its map. Taking it writes nothing.
 */
export const insertMap = (doc: Y.Doc, insert: Id): Stored<InsertFields> => stored(doc.getMap(insertName(insert)))

/**
 * The insert's own, if the document holds a map of it: reading one it doesn't hold makes no map of the top, so a view
 * of many inserts leaves the document's top as it was.
 */
export const foundInsertMap = (doc: Y.Doc, insert: Id): Option.Option<Stored<InsertFields>> =>
  Option.map(Option.fromUndefinedOr(doc.share.get(insertName(insert))), () => insertMap(doc, insert))
