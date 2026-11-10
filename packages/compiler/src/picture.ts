import { LoopTicks, type Place } from '@escapement/engine'
import {
  type AnyParam,
  defaultStrip,
  lastTick,
  type MidiKey,
  maxTempo,
  minTempo,
  nearestIn,
  type ParamValues,
  type Plugin,
  type SampleSounds,
  type StripValues,
  strip,
  type Tick
} from '@escapement/engine-description'
import {
  byContent,
  type Holds,
  HoldTarget,
  heardOf,
  heldValue,
  playedOf,
  type Id,
  type Listening,
  type Master,
  type Note,
  type PlayedClip,
  type PluginInstance,
  type Slot,
  type Auditions,
  type ProjectAtoms,
  trackStrip
} from '@escapement/model'
import { Array, Boolean, Data, Number, Option, Predicate, Record, Schema } from 'effect'
import { Atom } from 'effect/reactivity'

// By their kind, so no document ID can take another's node: a track keyed `master`, or a track and a slot with one ID.
const trackNode = (id: Id) => `track:${id}`
/** The end of a track's chain: it plays the track's volume and pan, and has its meter. */
const trackFaderNode = (id: Id) => `fader:${id}`
const slotNode = (id: Id) => `slot:${id}`
/** Where every track goes, summed. */
const masterNode = 'master'
/** The end of the master's chain, which plays its volume and pan: what the engine puts out. */
const masterFaderNode = 'master-fader'

/** What makes a node itself: when it changes, a new node takes the old one's place. */
export type NodeKind = Data.TaggedEnum<{
  /** With the meter of what it passes on if it is a track's fader, the track's by ID, for its strip in the mixer. */
  Insert: { readonly meter: Option.Option<Id> }
  Plugin: { readonly plugin: Plugin; readonly samples: SampleSounds<Plugin> }
}>

export const NodeKind = Data.taggedEnum<NodeKind>()

export interface NodePicture {
  readonly kind: NodeKind
  /** Changed on the node as it plays. */
  readonly params: ParamValues<Plugin>
  /** Its volume and pan after what it does, changed as it plays too. */
  readonly strip: StripValues
}

export interface PictureNote {
  /** From the pattern's start. */
  readonly tick: Tick
  /** The key of the node that plays it. */
  readonly node: string
  readonly key: MidiKey
  readonly velocity: number
  /** Ticks, from 1. */
  readonly length: number
}

/** A note played by hand on a node, from its press to its release. */
export interface PictureAudition {
  /** The key of the node that plays it. */
  readonly node: string
  readonly key: MidiKey
  readonly velocity: number
  /** Tells it from every other played by hand. */
  readonly press: number
}

/**
 * The key of the notes a pattern plays on a track, among the picture's patterns: a pattern on two tracks plays on two
 * nodes. JSON, so no two IDs make one key.
 */
const patternKey = (track: Id, pattern: Id) => JSON.stringify([track, pattern])

/** A pattern played from a tick of the loop, for its length. */
export interface PictureClip {
  readonly tick: Tick
  /** Ticks, from 1. */
  readonly length: number
  /** Ticks, from 1: the pattern starts again every so many. */
  readonly period: number
  /** Ticks into a round of its pattern it starts at, under its period. */
  readonly offset: number
  /** Its pattern's on its track, as `patternKey` makes it: its key among the picture's patterns. */
  readonly pattern: string
}

/** Whether the clips play, round and round the loop, and where this client last put the position. */
export interface Transport {
  readonly playing: boolean
  readonly loopTicks: LoopTicks
  readonly place: Place
}

/**
 * What the engine plays for a project: for each track with an instrument a node and its fader, the master and its
 * slots, by the document ID of what they play, and how they join; and whether it plays. A track not heard keeps its
 * nodes, the instrument joined to nothing, and presses no notes.
 */
export interface Picture {
  readonly nodes: Readonly<Record<string, NodePicture>>
  /** `to` hears `from`. */
  readonly connections: ReadonlyArray<readonly [from: string, to: string]>
  readonly output: Option.Option<string>
  /** The keys of the tracks' nodes heard: one that stops being heard has its notes let go of. */
  readonly heard: ReadonlyArray<string>
  /** The notes of each pattern a clip plays on its track, by `patternKey`: the clips play only those. */
  readonly patterns: Readonly<Record<string, ReadonlyArray<PictureNote>>>
  readonly clips: ReadonlyArray<PictureClip>
  /** Of the tracks heard, while the arrangement doesn't play. */
  readonly auditions: ReadonlyArray<PictureAudition>
  readonly tempo: Option.Option<number>
  readonly transport: Option.Option<Transport>
}

/**
 * What this client does with the project, its own and never in the document: how it listens, the controls it holds,
 * whether it plays and where it last put the position, and the notes it plays by hand.
 */
export interface Client {
  readonly listening: Atom.Atom<Listening>
  readonly holds: Atom.Atom<Holds>
  readonly playing: Atom.Atom<boolean>
  readonly place: Atom.Atom<Place>
  readonly auditions: Atom.Atom<Auditions>
}

/** What an engine has before anything is built. */
export const emptyPicture: Picture = {
  nodes: {},
  connections: [],
  output: Option.none(),
  heard: [],
  patterns: {},
  clips: [],
  auditions: [],
  tempo: Option.none(),
  transport: Option.none()
}

/** A held value by parameter ID. */
type Held = ReadonlyArray<readonly [param: string, value: number]>

/** The values held on a node: for its plugin's parameters and for its strip's. */
interface NodeHeld {
  readonly params: Held
  readonly strip: Held
}

/** The node a held value plays on, by its key, and the parameter it sets there; the tempo plays on none. */
const heldParam = (target: HoldTarget): Option.Option<readonly [node: string, on: keyof NodeHeld, param: string]> =>
  HoldTarget.$match(target, {
    TrackParam: ({ track, param }) => Option.some([trackNode(track), 'params', param] as const),
    TrackStrip: ({ track, param }) => Option.some([trackFaderNode(track), 'strip', param] as const),
    SlotParam: ({ slot, param }) => Option.some([slotNode(slot), 'params', param] as const),
    MasterStrip: ({ param }) => Option.some([masterFaderNode, 'strip', param] as const),
    Tempo: () => Option.none()
  })

/** The values held on the node. */
const heldOn = (holds: Holds, node: string): NodeHeld => {
  const held = holds.flatMap(({ target, value }) =>
    heldParam(target).pipe(
      Option.filter(([at]) => at === node),
      Option.map(([, on, param]) => ({ on, entry: [param, value] as const })),
      Option.toArray
    )
  )
  const entriesOn = (part: keyof NodeHeld): Held => held.filter(({ on }) => on === part).map(({ entry }) => entry)
  return { params: entriesOn('params'), strip: entriesOn('strip') }
}

const isFiniteNumber = Schema.is(Schema.Finite)

/** A held value as the document's would be read: a number in the parameter's range, a choice the nearest, or none. */
const playable = (descriptions: ReadonlyArray<AnyParam>, [id, value]: Held[number]): Option.Option<Held[number]> =>
  Option.zipWith(
    Option.fromUndefinedOr(descriptions.find((description) => description.id === id)),
    Option.liftPredicate(value, isFiniteNumber),
    (description, played) => [id, nearestIn(description, played)] as const
  )

/** `values` with the ones held over them, those it has a description of. */
const withHeld = <V>(values: V, descriptions: ReadonlyArray<AnyParam>, held: Held): V => ({
  ...values,
  ...Object.fromEntries(held.flatMap((entry) => Option.toArray(playable(descriptions, entry))))
})

/** The node an instance makes, the values held for its parameters over the document's, its strip the engine's. */
const pluginNode = ({ plugin, params, samples }: PluginInstance, held: NodeHeld): NodePicture => ({
  kind: NodeKind.Plugin({ plugin, samples }),
  params: withHeld(params, plugin.params, held.params),
  strip: defaultStrip
})

const isSlot = HoldTarget.$is('SlotParam')

/** The document's tempo, or the one held over it, in the engine's range. */
const tempoOf = (tempo: number, holds: Holds) =>
  Option.getOrElse(
    Option.map(Option.filter(heldValue(holds, HoldTarget.Tempo()), isFiniteNumber), (bpm) =>
      Number.clamp(bpm, { minimum: minTempo, maximum: maxTempo })
    ),
    () => tempo
  )

/** A node of the engine's core that passes on the sum of what goes into it, at the volume and pan given. */
const passing = (values: StripValues, meter = Option.none<Id>()): NodePicture => ({
  kind: NodeKind.Insert({ meter }),
  params: {},
  strip: values
})

/** The master's nodes and how they join. */
interface MasterChain {
  readonly nodes: Readonly<Record<string, NodePicture>>
  readonly connections: ReadonlyArray<readonly [from: string, to: string]>
}

/** The master's sum, its slots in their order, then its fader, as held over the document's; its meter is the output. */
const masterChain = (
  values: StripValues,
  faderHeld: NodeHeld,
  slots: ReadonlyArray<Slot>,
  slotsHeld: Holds
): MasterChain => {
  const chain = [masterNode, ...slots.map((slot) => slotNode(slot.id)), masterFaderNode]
  return {
    nodes: {
      [masterNode]: passing(defaultStrip),
      ...Object.fromEntries(
        slots.map((slot) => [slotNode(slot.id), pluginNode(slot, heldOn(slotsHeld, slotNode(slot.id)))])
      ),
      [masterFaderNode]: passing(withHeld(values, strip, faderHeld.strip))
    },
    connections: chain.slice(1).map((to, i) => [chain[i], to] as const)
  }
}

/**
 * The pattern's notes on the track's node, each once: of notes alike in tick and key, the one with the lowest ID, as the
 * pattern has them by ID. A note is as long as the wire carries at most: the engine ends it by its clip's end and the
 * loop's.
 */
const notesOn = (track: Id, notes: ReadonlyArray<Note>): ReadonlyArray<PictureNote> =>
  // The keys have spaces, so none reads as an array index: the groups keep the order their first notes come in.
  Object.values(Array.groupBy(notes, ({ tick, key }): string => `${tick} ${key}`)).map(
    ([{ tick, key, velocity, length }]) => ({
      tick,
      node: trackNode(track),
      key,
      velocity,
      length: Math.min(length, lastTick)
    })
  )

const pictureClip = ({ tick, track, length, period, offset, pattern }: PlayedClip): PictureClip => ({
  tick,
  length,
  period,
  offset,
  pattern: patternKey(track, pattern)
})

/**
 * The picture of the project as this client listens to it, holds its controls, plays it and plays notes by hand, from
 * their atoms, which are written in batches (`batchedState`): read by more than one way, a change half of the way would
 * reach the engine as two. What plays is the arrangement. Each part is cut off by content, so turning a track's volume
 * doesn't read a pattern again, and a note changed reads only its own pattern. A track not heard, muted or left out of
 * a solo, presses no notes, by hand neither, and its instrument is cut off from its fader, so what it sounds falls
 * silent at once, its notes let go of, and its meter with it. Notes played by hand sound only while the arrangement
 * doesn't play.
 */
export const pictureOf = (
  project: ProjectAtoms,
  { listening, holds, playing, place, auditions }: Client
): Atom.Atom<Picture> => {
  // Each node reads only what is held for it: a turn makes its own node again, and no other.
  const heldAt = Atom.family((node: string) => byContent((get) => heldOn(get(holds), node)))
  const slotsHeld = byContent((get) => get(holds).filter(({ target }) => isSlot(target)))
  const instrumentOf = Atom.family((id: Id) =>
    byContent((get) =>
      Option.flatMap(get(project.track(id)), ({ instrument }) =>
        Option.map(instrument, (played) => pluginNode(played, get(heldAt(trackNode(id)))))
      )
    )
  )
  const faderOf = Atom.family((id: Id) =>
    byContent((get) =>
      Option.map(get(project.track(id)), ({ strip: values }) =>
        passing(withHeld(values, trackStrip, get(heldAt(trackFaderNode(id))).strip), Option.some(id))
      )
    )
  )
  /** The tracks with an instrument, each with its instrument's node and its fader's. */
  const tracks = byContent((get) =>
    get(project.trackIds).flatMap((id) =>
      Option.toArray(
        Option.zipWith(
          get(instrumentOf(id)),
          get(faderOf(id)),
          (instrument, fader) => [id, { instrument, fader }] as const
        )
      )
    )
  )
  const heard = heardOf(project, listening)
  const sounding = byContent((get) => {
    const into = new Set(get(heard))
    return get(tracks)
      .map(([id]) => id)
      .filter((id) => into.has(id))
  })
  const played = playedOf(project)
  /** The notes of a pattern a clip plays on a track: none while the track isn't heard. Keyed by the pair, as equal. */
  const notesPlayed = Atom.family(([track, pattern]: readonly [track: Id, pattern: Id]) =>
    byContent((get) =>
      Boolean.match(get(sounding).includes(track), {
        onTrue: () => notesOn(track, get(project.notes(pattern))),
        onFalse: () => []
      })
    )
  )
  // Two clips of one pattern on one track make one key, and one pattern in the engine.
  const patterns = byContent((get) =>
    Record.fromEntries(
      get(played).clips.map(
        ({ track, pattern }) => [patternKey(track, pattern), get(notesPlayed([track, pattern]))] as const
      )
    )
  )
  const clips = byContent((get) => get(played).clips.map(pictureClip))
  const loop = byContent((get) => LoopTicks(get(played).end))
  const heardAuditions = byContent(
    (get): ReadonlyArray<PictureAudition> =>
      Boolean.match(get(playing), {
        onTrue: () => [],
        onFalse: () => {
          const into = new Set(get(sounding))
          return get(auditions)
            .filter(({ track }) => into.has(track))
            .map(({ track, key, velocity, press }) => ({ node: trackNode(track), key, velocity, press }))
        }
      })
  )
  const mastering = byContent((get) => {
    const { strip: values, slots }: Master = get(project.master)
    return masterChain(values, get(heldAt(masterFaderNode)), slots, get(slotsHeld))
  })
  const tempo = byContent((get) => tempoOf(get(project.tempo), get(holds)))
  return Atom.readable((get): Picture => {
    const { nodes, connections } = get(mastering)
    const tracksPlayed = get(tracks)
    const heardIds = new Set(get(sounding))
    return {
      nodes: {
        ...Object.fromEntries(
          tracksPlayed.flatMap(([id, { instrument, fader }]) => [
            [trackNode(id), instrument],
            [trackFaderNode(id), fader]
          ])
        ),
        ...nodes
      },
      connections: [
        ...tracksPlayed.filter(([id]) => heardIds.has(id)).map(([id]) => [trackNode(id), trackFaderNode(id)] as const),
        ...tracksPlayed.map(([id]) => [trackFaderNode(id), masterNode] as const),
        ...connections
      ],
      output: Option.some(masterFaderNode),
      heard: get(sounding).map(trackNode),
      patterns: get(patterns),
      clips: get(clips),
      auditions: get(heardAuditions),
      tempo: Option.some(get(tempo)),
      transport: Option.some({ playing: get(playing), loopTicks: get(loop), place: get(place) })
    }
  })
}

/** Every sound the picture's nodes play, each once. */
export const soundsOf = ({ nodes }: Picture) =>
  Array.dedupe(
    Object.values(nodes).flatMap(({ kind }) =>
      NodeKind.$match(kind, {
        Insert: () => [],
        Plugin: ({ samples }) => Object.values(samples).filter(Predicate.isNotUndefined)
      })
    )
  )
