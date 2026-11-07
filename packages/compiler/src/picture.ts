import { LoopTicks } from '@escapement/engine'
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
  insertCount,
  insertNumber,
  insertOfNumber,
  master,
  playedOf,
  type Id,
  type Insert,
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
const slotNode = (id: Id) => `slot:${id}`
/** Where what goes into an insert sums. */
const insertNode = (id: Id) => `insert:${id}`
/** The end of an insert's chain, which plays its volume and pan. */
const faderNode = (id: Id) => `fader:${id}`

/** Where every other insert goes, and every track unless it goes into another. */
const masterNode = insertNode(master)

/** What makes a node itself: when it changes, a new node takes the old one's place. */
export type NodeKind = Data.TaggedEnum<{
  /** With the meter of a mixer strip, by its number, if it is one's fader. */
  Insert: { readonly meter: Option.Option<number> }
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

/** Whether the clips play, round and round the loop. */
export interface Transport {
  readonly playing: boolean
  readonly loopTicks: LoopTicks
}

/**
 * What the engine plays for a project: a node for each track with an instrument, the master insert and its slots, by
 * the document ID of what they play, and how they join; and whether it plays. A track not heard keeps its node, joined
 * to nothing, and presses no notes.
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
 * whether it plays, and the notes it plays by hand.
 */
export interface Client {
  readonly listening: Atom.Atom<Listening>
  readonly holds: Atom.Atom<Holds>
  readonly playing: Atom.Atom<boolean>
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
    TrackStrip: ({ track, param }) => Option.some([trackNode(track), 'strip', param] as const),
    SlotParam: ({ slot, param }) => Option.some([slotNode(slot), 'params', param] as const),
    InsertStrip: ({ insert, param }) => Option.some([faderNode(insert), 'strip', param] as const),
    TrackInsert: () => Option.none(),
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

/** A node's strip: its values, and the descriptions a value held over them is read by. */
interface StripOf {
  readonly values: StripValues
  readonly params: ReadonlyArray<AnyParam>
}

/** The engine's own, for a node no track makes, such as a slot of the master's. */
const engineStrip: StripOf = { values: defaultStrip, params: strip }

/** The node an instance makes, playing the values held for its parameters and its strip's over the document's. */
const pluginNode = (
  { plugin, params, samples }: PluginInstance,
  held: NodeHeld,
  { values, params: stripParams }: StripOf = engineStrip
): NodePicture => ({
  kind: NodeKind.Plugin({ plugin, samples }),
  params: withHeld(params, plugin.params, held.params),
  strip: withHeld(values, stripParams, held.strip)
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
const passing = (values: StripValues, meter = Option.none<number>()): NodePicture => ({
  kind: NodeKind.Insert({ meter }),
  params: {},
  strip: values
})

/**
 * A strip's meter, by its number, of what it passes on: none while it is muted, as nothing does; none for the master,
 * whose meter is the engine's output.
 */
const meterOf = (id: Id, mute: boolean) => Option.filter(insertNumber(id), (number) => number > 0 && !mute)

/** An insert's nodes and how they join, and its fader's key, which the next one along hears. */
interface InsertChain {
  readonly nodes: Readonly<Record<string, NodePicture>>
  readonly connections: ReadonlyArray<readonly [from: string, to: string]>
  readonly out: string
}

/**
 * What goes into an insert sums at its node, goes through its slots in their order, and comes out of its fader at its
 * volume and pan, or those held over them: after its slots, as a mixer's fader is. The fader has the strip's meter.
 */
const insertChain = (
  id: Id,
  values: StripValues,
  faderHeld: NodeHeld,
  slots: ReadonlyArray<Slot>,
  slotsHeld: Holds,
  mute: boolean
): InsertChain => {
  const chain = [insertNode(id), ...slots.map((slot) => slotNode(slot.id)), faderNode(id)]
  return {
    nodes: {
      [insertNode(id)]: passing(defaultStrip),
      ...Object.fromEntries(
        slots.map((slot) => [slotNode(slot.id), pluginNode(slot, heldOn(slotsHeld, slotNode(slot.id)))])
      ),
      [faderNode(id)]: passing(withHeld(values, strip, faderHeld.strip), meterOf(id, mute))
    },
    connections: chain.slice(1).map((to, i) => [chain[i], to] as const),
    out: faderNode(id)
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

/** The insert held for the track, by its number, the nearest there is; none for a value held that isn't a number. */
const heldInsert = (holds: Holds, track: Id): Option.Option<Id> =>
  Option.flatMap(Option.filter(heldValue(holds, HoldTarget.TrackInsert({ track })), isFiniteNumber), (number) =>
    insertOfNumber(nearestIn({ min: 0, max: insertCount, whole: true }, number))
  )

/**
 * The picture of the project as this client listens to it, holds its controls, plays it and plays notes by hand, from
 * their atoms, which are written in batches (`batchedState`): read by more than one way, a change half of the way would
 * reach the engine as two. What plays is the arrangement. Each part is cut off by content, so turning a track's volume
 * doesn't read a pattern again, and a note changed reads only its own pattern. A track not heard, muted or left out of
 * a solo, presses no notes, by hand neither, and is cut off from its insert, so what it sounds falls silent at once,
 * its notes let go of. Notes played by hand sound only while the arrangement doesn't play. An insert has a node while a
 * track with an instrument goes into it; muted, it doesn't go into the master.
 */
export const pictureOf = (
  project: ProjectAtoms,
  { listening, holds, playing, auditions }: Client
): Atom.Atom<Picture> => {
  // Each node reads only what is held for it: a turn makes its own node again, and no other.
  const trackHeld = Atom.family((id: Id) => byContent((get) => heldOn(get(holds), trackNode(id))))
  const slotsHeld = byContent((get) => get(holds).filter(({ target }) => isSlot(target)))
  const instrumentOf = Atom.family((id: Id) =>
    byContent((get) =>
      Option.flatMap(get(project.track(id)), ({ instrument, strip: values }) =>
        Option.map(instrument, (played) => pluginNode(played, get(trackHeld(id)), { values, params: trackStrip }))
      )
    )
  )
  const tracks = byContent((get) =>
    get(project.trackIds).flatMap((id) =>
      Option.toArray(Option.map(get(instrumentOf(id)), (node) => [id, node] as const))
    )
  )
  const routeOf = Atom.family((id: Id) =>
    byContent((get) =>
      Option.getOrElse(heldInsert(get(holds), id), () =>
        Option.match(get(project.track(id)), { onNone: () => master, onSome: ({ insert }) => insert })
      )
    )
  )
  /** The insert each track with an instrument goes into. */
  const routes = byContent((get) => get(tracks).map(([id]) => [id, get(routeOf(id))] as const))
  const faderHeld = Atom.family((id: Id) => byContent((get) => heldOn(get(holds), faderNode(id))))
  const insertOf = Atom.family((id: Id) =>
    byContent((get) => {
      const { strip: values, mute }: Insert = get(project.insert(id))
      return { chain: insertChain(id, values, get(faderHeld(id)), [], [], mute), mute }
    })
  )
  /** The inserts besides the master the tracks go into, each once. */
  const inserts = byContent((get) =>
    Array.dedupe(get(routes).map(([, insert]) => insert))
      .filter((insert) => insert !== master)
      .map((insert) => get(insertOf(insert)))
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
    return insertChain(master, values, get(faderHeld(master)), slots, get(slotsHeld), false)
  })
  const tempo = byContent((get) => tempoOf(get(project.tempo), get(holds)))
  return Atom.readable((get): Picture => {
    const { nodes, connections, out } = get(mastering)
    const played = get(tracks)
    const heardIds = new Set(get(sounding))
    const heardNodes = get(sounding).map(trackNode)
    const insertsPlayed = get(inserts)
    return {
      nodes: {
        ...Object.fromEntries(played.map(([id, node]) => [trackNode(id), node])),
        ...Object.fromEntries(insertsPlayed.flatMap(({ chain }) => Object.entries(chain.nodes))),
        ...nodes
      },
      connections: [
        ...get(routes)
          .filter(([id]) => heardIds.has(id))
          .map(([id, insert]) => [trackNode(id), insertNode(insert)] as const),
        ...insertsPlayed.flatMap(({ chain, mute }) => [
          ...chain.connections,
          ...Option.toArray(Option.liftPredicate([chain.out, masterNode] as const, () => !mute))
        ]),
        ...connections
      ],
      output: Option.some(out),
      heard: heardNodes,
      patterns: get(patterns),
      clips: get(clips),
      auditions: get(heardAuditions),
      tempo: Option.some(get(tempo)),
      transport: Option.some({ playing: get(playing), loopTicks: get(loop) })
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
