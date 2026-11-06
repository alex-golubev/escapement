import {
  MidiKey,
  type ParamId,
  type ParamValues,
  plugins,
  type Sha256,
  Tick,
  ticksPerQuarter
} from '@escapement/engine-description'
import { Boolean, Option } from 'effect'
import { Command, LoopTicks, PageNote } from '../src/commands'
import { DeviceEdit } from '../src/device-edits'
import {
  emptyNodeHandles,
  type HandleTable,
  NodeHandle,
  PatternHandle,
  releaseAll,
  releaseHandle,
  takeHandle
} from '../src/handles'
import { createInsert, createNode, setParam } from '../src/plugins'
import type { Transaction } from '../src/transactions'

/** Sixteenth notes. */
export const stepTicks = ticksPerQuarter / 4
export const stepCount = 16
/** A bar of steps: what the transport loops while the tests play a pattern. */
export const patternLoop = LoopTicks(stepCount * stepTicks)

/** The drums' pattern, the graph's only one: a reset frees its cell, and the next session makes it there again. */
export const drumsPattern = PatternHandle(1)

/** The drums' pattern played over and over, as the loop goes round. */
export const drumsClips = DeviceEdit.SetClips({
  clips: [{ tick: Tick(0), length: patternLoop, period: patternLoop, offset: 0, pattern: drumsPattern }]
})

/** A step of a drum's row. */
export interface GridStep {
  readonly drum: number
  /** From 0 to `stepCount` − 1. */
  readonly step: number
}

/** The steps switched on: the drums' pattern. */
export type Steps = ReadonlyArray<GridStep>

const isStep = (a: GridStep) => (b: GridStep) => a.drum === b.drum && a.step === b.step

export const isOn = (steps: Steps, step: GridStep) => steps.some(isStep(step))

/** On if it was off, off if it was on. */
export const toggledStep = (steps: Steps, step: GridStep): Steps =>
  Boolean.match(isOn(steps, step), {
    onTrue: () => steps.filter((on) => !isStep(step)(on)),
    onFalse: () => [...steps, step]
  })

/** The last node of its kind made, removed or not. */
interface Made {
  readonly node: NodeHandle
  readonly live: boolean
}

/** The plugins the graph plays besides the drums. */
export type TestPlugin = 'tone' | 'filter'

/** The drums made last, removed or not: a sampler each, and the sounds they play. */
interface MadeDrums {
  readonly nodes: ReadonlyArray<NodeHandle>
  readonly sounds: ReadonlyArray<Sha256>
  readonly live: boolean
  /** Whether the insert hears them. */
  readonly connected: boolean
}

/** A sampler playing one sound. */
export interface Drum {
  readonly hash: Sha256
}

/**
 * A small graph the engine's tests build by hand, without a project: a tone and drums into the master insert, and a
 * filter after it, at most.
 */
export interface TestGraph {
  readonly handles: HandleTable<NodeHandle>
  /** Made with the first node that goes into it; a reset takes it away. */
  readonly insert?: NodeHandle
  readonly tone?: Made
  readonly filter?: Made
  readonly drums?: MadeDrums
  /** The last tone removed, for edits that must be refused. */
  readonly removedTone?: NodeHandle
  readonly epoch: number
}

export const emptyTestGraph: TestGraph = { handles: emptyNodeHandles, epoch: 0 }

/** The graph once the engine takes the transaction, and the sounds it then needs and no longer needs. */
export interface TestGraphChange {
  readonly graph: TestGraph
  readonly transaction: Transaction
  readonly store?: ReadonlyArray<Sha256>
  readonly evict?: ReadonlyArray<Sha256>
}

/** It, if it wasn't removed. */
const liveOf = <M extends { readonly live: boolean }>(made: M | undefined) =>
  Option.filter(Option.fromUndefinedOr(made), (made) => made.live)

/** The node, if it wasn't removed. */
export const liveNode = (made: Made | undefined) => Option.map(liveOf(made), ({ node }) => node)

const hasTone = (graph: TestGraph) => Option.isSome(liveNode(graph.tone))

const hasFilter = (graph: TestGraph) => Option.isSome(liveNode(graph.filter))

const liveDrums = (graph: TestGraph) => liveOf(graph.drums)

/** `items` where `present`, none otherwise. */
const onlyIf = <A>(present: boolean, items: () => ReadonlyArray<A>): ReadonlyArray<A> =>
  Boolean.match(present, { onTrue: items, onFalse: () => [] })

/** Both together; none if neither is there. */
const joined = <A>(first: ReadonlyArray<A> | undefined, next: ReadonlyArray<A> | undefined) =>
  Boolean.match(first === undefined && next === undefined, {
    onTrue: () => undefined,
    onFalse: () => [...(first ?? []), ...(next ?? [])]
  })

/** `first`, then `next` made on the graph `first` leaves: one transaction, and every sound either stores or evicts. */
export const followedBy = (first: TestGraphChange, next: TestGraphChange): TestGraphChange => ({
  graph: next.graph,
  transaction: {
    edits: joined(first.transaction.edits, next.transaction.edits),
    commands: joined(first.transaction.commands, next.transaction.commands)
  },
  store: joined(first.store, next.store),
  evict: joined(first.evict, next.evict)
})

/** Each change made on the graph the one before leaves; one that doesn't apply there is left out. */
const chained = (
  start: TestGraphChange,
  changes: ReadonlyArray<(graph: TestGraph) => Option.Option<TestGraphChange>>
): TestGraphChange =>
  changes.reduce(
    (built, change) =>
      Option.match(change(built.graph), { onNone: () => built, onSome: (next) => followedBy(built, next) }),
    start
  )

/** The insert, made in a free cell if there is none yet; none if no cell is free. */
const withInsert = (graph: TestGraph): Option.Option<readonly [NodeHandle, TestGraphChange]> =>
  Option.match(Option.fromUndefinedOr(graph.insert), {
    onNone: () =>
      Option.map(takeHandle(graph.handles), ([insert, handles]) => [
        insert,
        { graph: { ...graph, handles, insert }, transaction: { edits: [createInsert(insert)] } }
      ]),
    onSome: (insert) => Option.some([insert, { graph, transaction: {} }])
  })

/** The output hears the filter if there is one, otherwise the insert. */
const heardFrom = (graph: TestGraph, insert: NodeHandle) =>
  onlyIf(!hasFilter(graph), () => [DeviceEdit.SetOutput({ node: insert })])

/** A cell for each of `count` nodes, or none if the table runs out. */
const takeHandles = (
  handles: HandleTable<NodeHandle>,
  count: number
): Option.Option<readonly [ReadonlyArray<NodeHandle>, HandleTable<NodeHandle>]> =>
  Boolean.match(count === 0, {
    onTrue: () => Option.some([[], handles] as const),
    onFalse: () =>
      Option.flatMap(takeHandle(handles), ([node, rest]) =>
        Option.map(takeHandles(rest, count - 1), ([nodes, last]) => [[node, ...nodes], last] as const)
      )
  })

/** Nodes in free cells, with the insert made first if need be; none if `present`, or too few cells are free. */
const add = (
  graph: TestGraph,
  present: boolean,
  count: number,
  change: (nodes: ReadonlyArray<NodeHandle>, insert: NodeHandle, graph: TestGraph) => TestGraphChange
): Option.Option<TestGraphChange> =>
  Boolean.match(present, {
    onTrue: () => Option.none(),
    onFalse: () =>
      Option.flatMap(withInsert(graph), ([insert, made]) =>
        Option.map(takeHandles(made.graph.handles, count), ([nodes, handles]) =>
          followedBy(made, change(nodes, insert, { ...made.graph, handles }))
        )
      )
  })

/** Into the insert. */
export const addTone = (graph: TestGraph, values: ParamValues<typeof plugins.tone> = {}) =>
  add(graph, hasTone(graph), 1, ([node], insert, next) => ({
    graph: { ...next, tone: { node, live: true } },
    transaction: {
      edits: [
        createNode(plugins.tone, node, values),
        DeviceEdit.Connect({ from: node, to: insert }),
        ...heardFrom(next, insert)
      ]
    }
  }))

/** After the insert, on the output. */
export const addFilter = (graph: TestGraph, values: ParamValues<typeof plugins.filter> = {}) =>
  add(graph, hasFilter(graph), 1, ([node], insert, next) => ({
    graph: { ...next, filter: { node, live: true } },
    transaction: {
      edits: [
        createNode(plugins.filter, node, values),
        DeviceEdit.Connect({ from: insert, to: node }),
        DeviceEdit.SetOutput({ node })
      ]
    }
  }))

export const removeTone = (graph: TestGraph): Option.Option<TestGraphChange> =>
  Option.map(liveNode(graph.tone), (tone) => ({
    graph: {
      ...graph,
      handles: releaseHandle(graph.handles, tone),
      tone: { node: tone, live: false },
      removedTone: tone
    },
    transaction: { edits: [DeviceEdit.DestroyNode({ node: tone })] }
  }))

/** Into the insert, unless `connected` is false. They play `steps`. */
export const addDrums = (
  graph: TestGraph,
  drums: ReadonlyArray<Drum>,
  steps: Steps,
  connected = true
): Option.Option<TestGraphChange> => {
  const sounds = drums.map(({ hash }) => hash)
  return add(graph, Option.isSome(liveDrums(graph)) || drums.length === 0, drums.length, (nodes, insert, next) => ({
    graph: { ...next, drums: { nodes, sounds, live: true, connected } },
    transaction: {
      edits: [
        ...drums.flatMap(({ hash }, i) => [
          createNode(plugins.sampler, nodes[i], {}, { sample: hash }),
          ...onlyIf(connected, () => [DeviceEdit.Connect({ from: nodes[i], to: insert })])
        ]),
        ...heardFrom(next, insert),
        patternOf(nodes, steps),
        drumsClips
      ]
    },
    store: sounds
  }))
}

/** Nothing else plays their sounds; the pattern goes with them, since it names only them. */
export const removeDrums = (graph: TestGraph): Option.Option<TestGraphChange> =>
  Option.map(liveDrums(graph), (drums) => ({
    graph: {
      ...graph,
      handles: drums.nodes.reduce(releaseHandle, graph.handles),
      drums: { ...drums, live: false }
    },
    transaction: { edits: [...drums.nodes.map((node) => DeviceEdit.DestroyNode({ node })), patternOf([], [])] },
    evict: drums.sounds
  }))

/** The insert stops hearing the drums, or hears them again: `Disconnect` or `Connect` for each. */
const connectingDrums = (graph: TestGraph, connected: boolean): Option.Option<TestGraphChange> =>
  Option.flatMap(liveDrums(graph), (drums) =>
    Option.map(
      Option.filter(Option.fromUndefinedOr(graph.insert), () => drums.connected !== connected),
      (insert): TestGraphChange => ({
        graph: { ...graph, drums: { ...drums, connected } },
        transaction: {
          edits: drums.nodes.map((from) =>
            Boolean.match(connected, {
              onTrue: () => DeviceEdit.Connect({ from, to: insert }),
              onFalse: () => DeviceEdit.Disconnect({ from, to: insert })
            })
          )
        }
      })
    )
  )

export const disconnectDrums = (graph: TestGraph) => connectingDrums(graph, false)

export const connectDrums = (graph: TestGraph) => connectingDrums(graph, true)

const middleC = MidiKey(60)

/** Each step on as a hit of its drum, as the pads play it. */
const patternOf = (drums: ReadonlyArray<NodeHandle>, steps: Steps) =>
  DeviceEdit.SetPattern({
    pattern: drumsPattern,
    notes: steps.flatMap(({ drum, step }) =>
      Option.toArray(
        Option.map(Option.fromUndefinedOr(drums[drum]), (node) => ({
          tick: Tick(step * stepTicks),
          node,
          key: middleC,
          velocity: 1,
          length: stepTicks
        }))
      )
    )
  })

/** The drums play `steps` from now on; none without live drums, which get them when they are added. */
export const setPattern = (graph: TestGraph, steps: Steps): Option.Option<Transaction> =>
  Option.map(liveDrums(graph), ({ nodes }) => ({ edits: [patternOf(nodes, steps)] }))

/** A hit from the start of the next block; none without live drums. */
export const playDrum = (graph: TestGraph, drum: number): Option.Option<Transaction> =>
  Option.map(
    Option.flatMap(liveDrums(graph), ({ nodes }) => Option.fromUndefinedOr(nodes[drum])),
    (node) => ({
      commands: [Command.NoteOn({ node, key: middleC, velocity: 1, note: PageNote(0) })]
    })
  )

/** The insert goes back on the output. */
export const removeFilter = (graph: TestGraph): Option.Option<TestGraphChange> =>
  Option.flatMap(liveNode(graph.filter), (filter) =>
    Option.map(Option.fromUndefinedOr(graph.insert), (insert) => ({
      graph: { ...graph, handles: releaseHandle(graph.handles, filter), filter: { node: filter, live: false } },
      transaction: { edits: [DeviceEdit.DestroyNode({ node: filter }), DeviceEdit.SetOutput({ node: insert })] }
    }))
  )

/** Starts the next session of this engine: a rebuild, so the sounds stay for the graph built after it. */
export const resetGraph = (graph: TestGraph): TestGraphChange => {
  const epoch = graph.epoch + 1
  const gone = <M extends { readonly live: boolean }>(made: M | undefined) =>
    Option.getOrUndefined(Option.map(Option.fromUndefinedOr(made), (made) => ({ ...made, live: false })))
  return {
    graph: {
      handles: releaseAll(graph.handles),
      tone: gone(graph.tone),
      filter: gone(graph.filter),
      drums: gone(graph.drums),
      removedTone: Option.getOrElse(liveNode(graph.tone), () => graph.removedTone),
      epoch
    },
    transaction: { edits: [DeviceEdit.Reset({ epoch })] }
  }
}

/** What a rebuild makes the nodes with: their values, the drums' sounds and the steps on. */
export interface GraphValues {
  readonly tone: ParamValues<typeof plugins.tone>
  readonly filter: ParamValues<typeof plugins.filter>
  readonly drums: ReadonlyArray<Drum>
  readonly steps: Steps
}

/** The insert on the output, unless a node made it already. */
const insertAlone = (graph: TestGraph): Option.Option<TestGraphChange> =>
  Option.match(Option.fromUndefinedOr(graph.insert), {
    onNone: () =>
      Option.map(withInsert(graph), ([insert, made]) =>
        followedBy(made, { graph: made.graph, transaction: { edits: [DeviceEdit.SetOutput({ node: insert })] } })
      ),
    onSome: () => Option.none()
  })

/**
 * The next session with every live node made again and the same pattern, in one transaction, as a full rebuild makes
 * it: the transport plays on and the pattern keeps its beat.
 */
export const rebuildGraph = (graph: TestGraph, values: GraphValues): TestGraphChange => {
  const rebuilt = chained(resetGraph(graph), [
    ...onlyIf(hasFilter(graph), () => [(next: TestGraph) => addFilter(next, values.filter)]),
    ...onlyIf(hasTone(graph), () => [(next: TestGraph) => addTone(next, values.tone)]),
    ...Option.toArray(
      Option.map(
        liveDrums(graph),
        ({ connected }) =>
          (next: TestGraph) =>
            addDrums(next, values.drums, values.steps, connected)
      )
    ),
    // The first node made again brings the insert along; with none, it comes back alone.
    ...onlyIf(graph.insert !== undefined, () => [insertAlone])
  ])
  // The reset keeps every sound stored, so the drums made again have none to store.
  return { ...rebuilt, store: undefined }
}

/** To the last node of its kind made: refused once it is gone. */
export const setGraphParam = <P extends TestPlugin>(
  graph: TestGraph,
  plugin: P,
  id: ParamId<(typeof plugins)[P]>,
  value: number
): Option.Option<Transaction> =>
  Option.map(Option.fromUndefinedOr(graph[plugin]), ({ node }) => ({
    commands: [setParam(plugins[plugin], node, id, value)]
  }))

/** A live edit and a device edit for the last tone removed, or for no node at all before one is: both refused. */
export const removedToneEdits = (graph: TestGraph): Transaction => {
  const node = graph.removedTone ?? NodeHandle(0)
  return { edits: [DeviceEdit.DestroyNode({ node })], commands: [setParam(plugins.tone, node, 'volume', 0)] }
}
