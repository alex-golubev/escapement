import {
  Command,
  createInsert,
  createNode,
  DeviceEdit,
  emptyNodeHandles,
  emptyPatternHandles,
  type HandleTable,
  type LiveCommand,
  type NodeHandle,
  PageNote,
  type PatternHandle,
  releaseAll,
  releaseHandle,
  setParam,
  setStripParam,
  takeHandle,
  type Transaction
} from '@escapement/engine'
import { type ParamId, type Plugin, strip } from '@escapement/engine-description'
import type { Id } from '@escapement/model'
import { Array, Equal, Option, Record } from 'effect'
import { emptyPicture, NodeKind, type NodePicture, type Picture } from './picture'

/** What the engine took last: the picture and the handles of its nodes and patterns. */
export interface Built {
  readonly picture: Picture
  readonly nodeHandles: HandleTable<NodeHandle>
  /** By the picture's keys. */
  readonly nodes: Readonly<Record<string, NodeHandle>>
  /** Whose meter each node with one has, a track's by ID, by the node's handle: what the telemetry names it by. */
  readonly meters: ReadonlyMap<NodeHandle, Id>
  readonly patternHandles: HandleTable<PatternHandle>
  /** By the keys of the picture's patterns. */
  readonly patterns: Readonly<Record<string, PatternHandle>>
  /** The engine's session: each reset starts the next. */
  readonly epoch: number
}

export const nothingBuilt: Built = {
  picture: emptyPicture,
  nodeHandles: emptyNodeHandles,
  nodes: {},
  meters: new Map(),
  patternHandles: emptyPatternHandles,
  patterns: {},
  epoch: 0
}

/** What makes the engine play a picture: the transaction, and what it has once it takes it. */
export interface Change {
  readonly transaction: Transaction
  readonly built: Built
}

export const isEmpty = ({ edits = [], commands = [] }: Transaction) => edits.length === 0 && commands.length === 0

const makeNode = ({ kind, params, strip: values }: NodePicture, node: NodeHandle): DeviceEdit =>
  NodeKind.$match(kind, {
    Insert: ({ meter }) => createInsert(node, values, Option.isSome(meter)),
    Plugin: ({ plugin, samples }) => createNode(plugin, node, params, samples, values)
  })

/** A command for each parameter whose value changed. */
const paramChanges = (before: NodePicture, next: NodePicture, node: NodeHandle): ReadonlyArray<LiveCommand> =>
  NodeKind.$match(next.kind, {
    Insert: () => [],
    Plugin: ({ plugin }) =>
      // The picture holds the plugin's own parameters, and no other.
      (Object.keys(next.params) as ReadonlyArray<ParamId<Plugin>>).flatMap((id) =>
        Option.fromUndefinedOr(next.params[id]).pipe(
          Option.filter((value) => value !== before.params[id]),
          Option.map((value) => setParam(plugin, node, id, value)),
          Option.toArray
        )
      )
  })

/** A command for each parameter of the strip whose value changed. */
const stripChanges = (before: NodePicture, next: NodePicture, node: NodeHandle): ReadonlyArray<LiveCommand> =>
  strip.filter(({ id }) => next.strip[id] !== before.strip[id]).map(({ id }) => setStripParam(node, id, next.strip[id]))

/** The value `next` has, unless `before` has the same. */
const changed = <A>(next: Option.Option<A>, before: Option.Option<A>): Option.Option<A> =>
  Option.filter(next, (value) => !Option.contains(before, value))

/** A handle for each key, taken from `table`, which `what` names should it run out. */
const takeAll = <H extends number>(table: HandleTable<H>, keys: ReadonlyArray<string>, what: string) =>
  keys.reduce<{ readonly table: HandleTable<H>; readonly handles: Readonly<Record<string, H>> }>(
    ({ table, handles }, key) => {
      const [handle, rest] = Option.getOrThrowWith(
        takeHandle(table),
        () => new RangeError(`Every ${what} cell is taken`)
      )
      return { table: rest, handles: { ...handles, [key]: handle } }
    },
    { table, handles: {} }
  )

const joined = ([from, to]: readonly [NodeHandle, NodeHandle]) => `${from} ${to}`

/** Whose meter each node of the picture with one has, by the node's handle. */
const metersOf = ({ nodes }: Picture, handles: Readonly<Record<string, NodeHandle>>): ReadonlyMap<NodeHandle, Id> =>
  new Map(
    Object.entries(nodes).flatMap(([key, { kind }]) =>
      NodeKind.$match(kind, {
        Insert: ({ meter }) => Option.toArray(Option.map(meter, (owner) => [handles[key], owner] as const)),
        Plugin: () => []
      })
    )
  )

/**
 * The change from what the engine has to `next`. A node whose kind changed is destroyed and made anew in a fresh cell
 * with its values; one that only has new values gets them as it plays. Connections are compared by handles, so a node
 * made anew is joined again. A pattern a clip plays is made once one does, goes whole once a note or a node it names
 * changes, and is destroyed once none does; the clips go whole once one of them, or a pattern's handle, changes.
 */
export const changeTo = (built: Built, next: Picture): Change => {
  const before = built.picture
  const kept = (key: string) => {
    const old = before.nodes[key]
    const now = next.nodes[key]
    return old !== undefined && now !== undefined && Equal.equals(old.kind, now.kind)
  }
  const gone = Object.keys(before.nodes).filter((key) => !kept(key))
  const made = Object.keys(next.nodes).filter((key) => !kept(key))
  const released = gone.reduce((table, key) => releaseHandle(table, built.nodes[key]), built.nodeHandles)
  const taken = takeAll(released, made, 'node')
  const nodes = {
    ...Record.filter(built.nodes, (_, key) => kept(key)),
    ...taken.handles
  }
  const handleOf = (key: string) => nodes[key]
  const oldHandleOf = (key: string) => built.nodes[key]

  const handlesOf = (connections: Picture['connections'], handles: (key: string) => NodeHandle) =>
    connections.map(([from, to]) => [handles(from), handles(to)] as const)
  const oldJoins = handlesOf(before.connections, oldHandleOf)
  const newJoins = handlesOf(next.connections, handleOf)
  const oldSet = new Set(oldJoins.map(joined))
  const newSet = new Set(newJoins.map(joined))
  // A destroyed node takes its connections with it.
  const disconnects = oldJoins.filter((join, i) => {
    const [from, to] = before.connections[i]
    return kept(from) && kept(to) && !newSet.has(joined(join))
  })
  const connects = newJoins.filter((join) => !oldSet.has(joined(join)))

  const output = changed(Option.map(next.output, handleOf), Option.map(before.output, oldHandleOf))
  // A node no longer heard lets go of the notes it holds, or the rest of a held note, a synth's, would come back with it;
  // a one-shot plays out on its own, as before. One made anew holds nothing.
  const stillHeard = new Set(next.heard)
  const silenced = before.heard.filter((key) => kept(key) && !stillHeard.has(key))

  const patternKept = (key: string) => Record.has(before.patterns, key) && Record.has(next.patterns, key)
  const patternsGone = Object.keys(before.patterns).filter((key) => !patternKept(key))
  const patternsMade = Object.keys(next.patterns).filter((key) => !patternKept(key))
  const takenPatterns = takeAll(
    patternsGone.reduce((table, key) => releaseHandle(table, built.patterns[key]), built.patternHandles),
    patternsMade,
    'pattern'
  )
  const patterns = { ...Record.filter(built.patterns, (_, key) => patternKept(key)), ...takenPatterns.handles }
  type Notes = Picture['patterns'][string]
  const notesIn = (notes: Notes, handles: (key: string) => NodeHandle) =>
    notes.map(({ tick, node, key, velocity, length }) => ({ tick, node: handles(node), key, velocity, length }))
  // A node made anew has a new handle: the same notes naming none are the same on the wire, with nothing to compare.
  const remade = new Set([...gone, ...made])
  const sameOnWire = (old: Notes, notes: Notes) => old === notes && notes.every(({ node }) => !remade.has(node))
  const patternChanged = (key: string, notes: Notes) =>
    Option.match(
      Option.liftPredicate(before.patterns[key], () => patternKept(key)),
      {
        onNone: () => true,
        onSome: (old) => !sameOnWire(old, notes) && !Equal.equals(notesIn(notes, handleOf), notesIn(old, oldHandleOf))
      }
    )
  const patternsSet = Object.entries(next.patterns)
    .filter(([key, notes]) => patternChanged(key, notes))
    .map(([key, notes]) => DeviceEdit.SetPattern({ pattern: patterns[key], notes: notesIn(notes, handleOf) }))
  const clipsIn = (clips: Picture['clips'], handles: Readonly<Record<string, PatternHandle>>) =>
    clips.map(({ tick, length, period, offset, pattern }) => ({
      tick,
      length,
      period,
      offset,
      pattern: handles[pattern]
    }))
  const clips = Option.liftPredicate(
    clipsIn(next.clips, patterns),
    (clips) => !Equal.equals(clips, clipsIn(before.clips, built.patterns))
  )

  // A note played by hand is pressed once, and again on a node made anew, which holds nothing; let go of on a node kept.
  const pressedBefore = new Set(before.auditions.filter(({ node }) => kept(node)).map(({ press }) => press))
  const pressedNext = new Set(next.auditions.map(({ press }) => press))
  const pressed = next.auditions.filter(({ press }) => !pressedBefore.has(press))
  const letGo = before.auditions.filter(({ node, press }) => kept(node) && !pressedNext.has(press))

  const edits: ReadonlyArray<DeviceEdit> = [
    ...gone.map((key) => DeviceEdit.DestroyNode({ node: built.nodes[key] })),
    ...made.map((key) => makeNode(next.nodes[key], handleOf(key))),
    // Before the connections: one that turns round would otherwise close a loop.
    ...disconnects.map(([from, to]) => DeviceEdit.Disconnect({ from, to })),
    ...connects.map(([from, to]) => DeviceEdit.Connect({ from, to })),
    ...Option.toArray(Option.map(output, (node) => DeviceEdit.SetOutput({ node }))),
    // Before the patterns made: one may take a cell another left.
    ...patternsGone.map((key) => DeviceEdit.DestroyPattern({ pattern: built.patterns[key] })),
    ...patternsSet,
    ...Option.toArray(Option.map(clips, (clips) => DeviceEdit.SetClips({ clips }))),
    ...silenced.map((key) => DeviceEdit.LetGoOfNotes({ node: handleOf(key) }))
  ]
  const commands: ReadonlyArray<LiveCommand> = [
    ...Object.keys(next.nodes)
      .filter(kept)
      .flatMap((key) => [
        ...paramChanges(before.nodes[key], next.nodes[key], handleOf(key)),
        ...stripChanges(before.nodes[key], next.nodes[key], handleOf(key))
      ]),
    ...Option.toArray(Option.map(changed(next.tempo, before.tempo), (bpm) => Command.SetTempo({ bpm }))),
    ...Option.toArray(
      Option.map(changed(next.transport, before.transport), (transport) => Command.SetTransport(transport))
    ),
    ...letGo.map(({ node, press }) => Command.NoteOff({ node: handleOf(node), note: PageNote(press) })),
    ...pressed.map(({ node, key, velocity, press }) =>
      Command.NoteOn({ node: handleOf(node), key, velocity, note: PageNote(press) })
    )
  ]
  return {
    transaction: { edits, commands },
    built: {
      ...built,
      picture: next,
      nodeHandles: taken.table,
      nodes,
      // Only a node made or gone changes whose meter is where.
      meters: Array.match([...gone, ...made], { onEmpty: () => built.meters, onNonEmpty: () => metersOf(next, nodes) }),
      patternHandles: takenPatterns.table,
      patterns
    }
  }
}

/** The next session: a reset, and everything built again in the same transaction, as from nothing. */
export const rebuildTo = (built: Built, next: Picture): Change => {
  const epoch = built.epoch + 1
  const change = changeTo(
    {
      ...built,
      picture: emptyPicture,
      nodeHandles: releaseAll(built.nodeHandles),
      nodes: {},
      meters: new Map(),
      patternHandles: releaseAll(built.patternHandles),
      patterns: {},
      epoch
    },
    next
  )
  const { edits = [], commands } = change.transaction
  return { ...change, transaction: { edits: [DeviceEdit.Reset({ epoch }), ...edits], commands } }
}
