import type {
  MidiKey,
  ParamId,
  PluginName,
  plugins,
  SampleSounds,
  StripValues,
  Tick
} from '@escapement/engine-description'
import type { Option } from 'effect'
import type { Colour } from './colour'
import type { Id } from './id'

type InstanceOf<N extends PluginName> = {
  readonly name: N
  readonly plugin: (typeof plugins)[N]
  readonly params: Readonly<Record<ParamId<(typeof plugins)[N]>, number>>
  readonly samples: SampleSounds<(typeof plugins)[N]>
}

/**
 * A plugin as a project plays it: every parameter has a value, and a sample without a sound is left out. Its name
 * tells which plugin it is, and so which parameters it has.
 */
export type PluginInstance = { readonly [N in PluginName]: InstanceOf<N> }[PluginName]

export interface Track {
  readonly id: Id
  readonly name: string
  /** Its head's, its strip's and its clips'. */
  readonly colour: Colour
  readonly mute: boolean
  /** Its volume and pan, after the instrument: its fader in the mixer. */
  readonly strip: StripValues
  /** None when the document has none this build can play: the track is silent. */
  readonly instrument: Option.Option<PluginInstance>
}

export interface Note {
  readonly id: Id
  readonly tick: Tick
  /** Whole ticks, from 1. */
  readonly length: number
  readonly key: MidiKey
  /** From 0 to 1. */
  readonly velocity: number
}

/** The notes a clip plays, by the instrument of the track it is on. */
export interface Pattern {
  readonly id: Id
  /** By ID: the same on every client. */
  readonly notes: ReadonlyArray<Note>
}

/** Notes on a track of the arrangement: it plays its pattern from its tick, round and round. */
export interface Clip {
  readonly id: Id
  readonly track: Id
  readonly tick: Tick
  readonly pattern: Id
  /** Ticks, from 1, once it is given a length of its own; none while it is as long as its pattern. */
  readonly ownLength: Option.Option<number>
  /**
   * Ticks into its pattern's rounds it starts at: they start this far before its tick, round and round its pattern's
   * length. Kept as written, under 0 or past the length as a trim left it, so the rounds stay where they were as the
   * pattern grows or shrinks.
   */
  readonly offset: number
}

/** A clip as the arrangement plays it: as long as it is, its pattern starting again each time it ends. */
export interface ArrangementClip extends Clip {
  /** Ticks, from 1: its own length, or else its pattern's. */
  readonly length: number
  /** Ticks, from 1: its pattern's length, `patternEnd`. */
  readonly period: number
}

export type Slot = PluginInstance & { readonly id: Id }

/** Where every track goes. */
export interface Master {
  /** Its volume and pan, after its slots. */
  readonly strip: StripValues
  /** In their order. */
  readonly slots: ReadonlyArray<Slot>
}

/** What a project is, read from its document: only what isn't deleted. */
export interface Project {
  readonly tempo: number
  /** In their order. */
  readonly tracks: ReadonlyArray<Track>
  /** On the live tracks, by ID. */
  readonly clips: ReadonlyArray<Clip>
  /** The clips', each once, by ID. */
  readonly patterns: ReadonlyArray<Pattern>
  readonly master: Master
}
