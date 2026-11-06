import { plugins, Sha256 } from '@escapement/engine-description'
import { Option } from 'effect'
import { expect, test } from 'vitest'
import { DeviceEdit } from '../src/device-edits'
import { handleOf, NodeHandle } from '../src/handles'
import { createInsert, createNode, setParam } from '../src/plugins'
import {
  addDrums,
  addFilter,
  addTone,
  connectDrums,
  disconnectDrums,
  emptyTestGraph,
  liveNode,
  rebuildGraph,
  removedToneEdits,
  removeDrums,
  removeFilter,
  removeTone,
  resetGraph,
  setGraphParam,
  type TestGraph,
  type TestGraphChange
} from './test-graph'
import {
  batchOf,
  editRejected,
  filter,
  filterEdits,
  fullVolumePeak,
  insert,
  live,
  marker,
  missingNode,
  rampBlocks,
  rejected,
  setVolume,
  startEngine,
  type TestEngine,
  tone,
  toneEdits
} from './harness'

test('an engine started without edits is silent', () => {
  const engine = startEngine({ initial: {} })
  expect(Array.from({ length: 4 }, engine.peak)).toEqual([0, 0, 0, 0])
  expect(engine.readEvents()).toEqual([])
})

test('live edits behind a batch wait for its parcel, then apply before the node is first heard', () => {
  const engine = startEngine({ initial: {} })
  const written = engine.write({ edits: toneEdits(), commands: [setVolume(0.25)] })
  expect(Array.from({ length: 3 }, engine.peak)).toEqual([0, 0, 0])
  // The volume waited instead of finding no node.
  expect(engine.readEvents()).toEqual([])
  engine.builder.build(Option.getOrThrowWith(batchOf(written), () => new Error('The batch was not written')))
  // As if the tone had been made at that volume.
  expect(engine.peak()).toBeCloseTo(startEngine({ initial: { edits: toneEdits(0.25) } }).peak(), 6)
})

test('a batch does not overtake live edits sent before it', () => {
  const engine = startEngine()
  engine.peak()
  // Meant for the node about to be replaced.
  engine.send(live(setVolume(0.1)))
  engine.send({ edits: [DeviceEdit.Reset({ epoch: 1 }), ...toneEdits()] })
  expect(engine.settledPeak()).toBeCloseTo(fullVolumePeak / 2, 3)
})

test('a reset removes every node and starts a session; every parcel comes back once the sound has faded', () => {
  const engine = startEngine()
  engine.send({
    edits: [createNode(plugins.tone, NodeHandle(40))]
  })
  expect(engine.peak()).toBeGreaterThan(0)
  engine.send({ edits: [DeviceEdit.Reset({ epoch: 3 })], commands: [missingNode] })
  Array.from({ length: rampBlocks }, engine.peak)
  expect(engine.peak()).toBe(0)
  expect(engine.readTelemetry()?.epoch).toBe(3)
  expect(engine.readEvents()).toEqual([rejected('UnknownTarget', 3)])
  expect(engine.builder.collect()).toBe(0)
  // Each cell is free again.
  engine.send({ edits: toneEdits() })
  expect(engine.peak()).toBeGreaterThan(0)
  expect(engine.readEvents()).toEqual([])
})

test('edits the build thread refused come back with their batch and session; the rest of the batch applies', () => {
  const engine = startEngine()
  const unknownVersion = {
    node: filter,
    plugin: plugins.tone.id,
    version: plugins.tone.version + 1,
    params: [],
    samples: [],
    strip: []
  }
  engine.send({
    edits: [
      createNode(plugins.tone, tone),
      DeviceEdit.CreateNode(unknownVersion),
      DeviceEdit.Reset({ epoch: 4 }),
      createNode(plugins.tone, NodeHandle(0)),
      createNode(plugins.tone, tone, { volume: Number.NaN }),
      DeviceEdit.SetOutput({ node: NodeHandle(3) }),
      DeviceEdit.SetOutput({ node: tone })
    ]
  })
  // The tone made after the reset plays at its default volume.
  expect(engine.settledPeak()).toBeCloseTo(fullVolumePeak / 2, 3)
  expect(engine.readEvents()).toEqual([
    editRejected(2, 'CellTaken'),
    editRejected(2, 'UnknownPlugin'),
    editRejected(2, 'InvalidHandle', 4),
    editRejected(2, 'InvalidValue', 4),
    editRejected(2, 'UnknownTarget', 4)
  ])
  // Bytes that aren't a batch still get a parcel, so the ring moves on.
  engine.builder.build({ _tag: 'Batch', number: 3, bytes: new Uint8Array([1, 2, 3]) })
  engine.sendBytes([marker(3)])
  engine.send(live(missingNode))
  engine.peak()
  expect(engine.readEvents()).toEqual([editRejected(3, 'Malformed', 4), rejected('UnknownTarget', 4)])
})

test('a marker for a batch that is not next is refused at once and holds nothing back', () => {
  const engine = startEngine()
  engine.peak()
  engine.sendBytes([marker(1), marker(9)])
  engine.send(live(setVolume(0.25)))
  expect(engine.settledPeak()).toBeCloseTo(fullVolumePeak * 0.25, 3)
  expect(engine.readEvents()).toEqual([rejected('UnknownTarget'), rejected('UnknownTarget')])
})

test('once the command stream is lost, parcels go back unapplied instead of piling up', () => {
  const engine = startEngine()
  engine.sendBytes([new Uint8Array([0xfc, 0xff, 0xff, 0xff])])
  engine.peak()
  engine.send({ edits: [DeviceEdit.Reset({ epoch: 1 })] })
  engine.peak()
  expect(engine.builder.collect()).toBe(0)
  expect(engine.readTelemetry()).toMatchObject({ epoch: 0, heapCalls: 0 })
  expect(engine.settledPeak()).toBeCloseTo(fullVolumePeak / 2, 3)
})

test('the tone heard through the filter gets quieter as the cutoff goes down', () => {
  const engine = startEngine({ initial: { edits: [...toneEdits(), ...filterEdits()] } })
  // Open, the filter leaves the tone as it is.
  expect(engine.settledPeak()).toBeCloseTo(fullVolumePeak / 2, 3)
  engine.send(live(setParam(plugins.filter, filter, 'cutoff', 200)))
  // 440 Hz is more than an octave above: over 12 dB down.
  expect(engine.settledPeak()).toBeLessThan(fullVolumePeak / 2 / 4)
  expect(engine.readEvents()).toEqual([])
})

const largestStep = (samples: ReadonlyArray<number>) =>
  samples.slice(1).reduce((step, sample, i) => Math.max(step, Math.abs(sample - samples[i])), 0)

/** The mean over each period of the 440 Hz tone: away from zero, the sound has a thump in it. */
const largestThump = (samples: ReadonlyArray<number>) => {
  const period = Math.round(48_000 / 440)
  const means = Array.from(
    { length: samples.length - period + 1 },
    (_, i) => samples.slice(i, i + period).reduce((sum, sample) => sum + sample, 0) / period
  )
  return Math.max(...means.map(Math.abs))
}

/** The left channel, block by block. */
const leftOf = (engine: TestEngine) => {
  const channels = [new Float32Array(128), new Float32Array(128)]
  return (blocks: number) =>
    Array.from({ length: blocks }, () => {
      engine.render(channels)
      return Array.from(channels[0])
    }).flat()
}

/** The tone's own largest step between samples, at its default volume. */
const toneStep = () => {
  const left = leftOf(startEngine())
  left(rampBlocks)
  return largestStep(left(3))
}

/** No step between samples beyond the tone's own, and no thump. */
const expectSmooth = (heard: ReadonlyArray<number>) => {
  expect(largestStep(heard)).toBeLessThanOrEqual(toneStep() * 1.05)
  expect(largestThump(heard)).toBeLessThan(fullVolumePeak / 2 / 20)
}

test.each([undefined, 200, 40])('a filter goes into a playing tone without a click, at cutoff %s', (cutoff) => {
  const engine = startEngine()
  const left = leftOf(engine)
  left(rampBlocks)
  const alone = left(3)
  engine.send({ edits: filterEdits(cutoff) })
  const heard = [...alone, ...left(16)]
  expect(largestStep(heard)).toBeLessThanOrEqual(largestStep(alone) * 1.05)
  expect(largestThump(heard)).toBeLessThan(fullVolumePeak / 2 / 20)
})

/** The tone, through a filter at `cutoff` if there is one. */
const toneThrough = (cutoff: number | undefined) => ({
  edits: [...toneEdits(), ...Option.match(Option.fromUndefinedOr(cutoff), { onNone: () => [], onSome: filterEdits })]
})

/** A filter rings out on its own; the tone alone just stops. */
const leftAtTheEnd = (cutoff: number | undefined) =>
  Option.match(Option.fromUndefinedOr(cutoff), { onNone: () => 0, onSome: () => 1e-4 })

test.each([undefined, 200, 40])('a tone removed fades out without a click, through a filter at %s', (cutoff) => {
  const engine = startEngine({ initial: toneThrough(cutoff) })
  const left = leftOf(engine)
  left(rampBlocks)
  const before = left(3)
  engine.send({ edits: [DeviceEdit.DestroyNode({ node: tone })] })
  const heard = [...before, ...left(2 * rampBlocks)]
  expectSmooth(heard)
  const end = heard.slice(-128).map(Math.abs)
  expect(Math.max(...end)).toBeLessThanOrEqual(leftAtTheEnd(cutoff))
  expect(engine.readEvents()).toEqual([])
  expect(engine.builder.collect()).toBe(0)
})

/** Applies a change of the page's graph, as its buttons do. */
const changed = (engine: TestEngine, change: Option.Option<TestGraphChange>): TestGraph => {
  const { graph, transaction } = Option.getOrThrow(change)
  expect(engine.send(transaction)).toBe(true)
  return graph
}

test('a command and an edit for a removed tone are both refused, even with a new tone in its cell', () => {
  const engine = startEngine({ initial: {} })
  const added = changed(engine, addTone(emptyTestGraph, { volume: 0.25 }))
  const removed = changed(engine, removeTone(added))
  const again = changed(engine, addTone(removed, { volume: 0.25 }))
  expect(again.tone?.node, 'its cell in the next generation').toBe(handleOf(1, tone))
  expect(engine.send(removedToneEdits(again))).toBe(true)
  expect(engine.settledPeak()).toBeCloseTo(fullVolumePeak * 0.25, 3)
  expect(engine.readEvents()).toEqual([editRejected(4, 'UnknownTarget'), rejected('UnknownTarget')])
  // The volume slider reaches the new tone.
  expect(engine.send(Option.getOrThrow(setGraphParam(again, 'tone', 'volume', 0.5)))).toBe(true)
  expect(engine.settledPeak()).toBeCloseTo(fullVolumePeak * 0.5, 3)
})

test("the page's buttons, in any order, change the sound without a click and without a refusal", () => {
  const engine = startEngine({ initial: {} })
  const left = leftOf(engine)
  // Drums without their sounds are silent, but their edits go through as the page's do.
  const drums = ['0d', '0e'].map((byte) => ({ hash: Sha256(byte.repeat(32)) }))
  const steps: ReadonlyArray<(graph: TestGraph) => Option.Option<TestGraphChange>> = [
    (graph) => addTone(graph),
    (graph) => addDrums(graph, drums, []),
    (graph) => addFilter(graph, { cutoff: 200 }),
    disconnectDrums,
    removeFilter,
    connectDrums,
    (graph) => addFilter(graph, { cutoff: 40 }),
    removeTone,
    (graph) => addTone(graph),
    (graph) => Option.some(resetGraph(graph)),
    (graph) => addFilter(graph, { cutoff: 300 }),
    (graph) => addTone(graph),
    (graph) => addDrums(graph, drums, []),
    removeFilter,
    disconnectDrums,
    removeDrums,
    removeTone
  ]
  // Each step once its fades are over, then all of them again a block apart, from the graph the first round left.
  const { heard } = [2 * rampBlocks, 1].reduce(
    (before, blocks) => {
      const round = steps.reduce(
        ({ graph, heard }, step) => ({ graph: changed(engine, step(graph)), heard: [...heard, ...left(blocks)] }),
        before
      )
      return { graph: round.graph, heard: [...round.heard, ...left(2 * rampBlocks)] }
    },
    { graph: emptyTestGraph, heard: [] as ReadonlyArray<number> }
  )
  expectSmooth(heard)
  expect(engine.readEvents()).toEqual([])
})

test('connections the engine cannot make come back with their batch, and the sound goes on', () => {
  const engine = startEngine()
  engine.send({ edits: filterEdits() })
  engine.send({
    edits: [
      DeviceEdit.Connect({ from: filter, to: tone }),
      DeviceEdit.Connect({ from: insert, to: filter }),
      DeviceEdit.Connect({ from: tone, to: NodeHandle(0) }),
      DeviceEdit.Connect({ from: filter, to: filter }),
      DeviceEdit.Connect({ from: handleOf(1, tone), to: filter }),
      DeviceEdit.Disconnect({ from: filter, to: tone }),
      DeviceEdit.Disconnect({ from: tone, to: NodeHandle(0) })
    ]
  })
  expect(engine.settledPeak()).toBeCloseTo(fullVolumePeak / 2, 3)
  expect(engine.readEvents()).toEqual([
    editRejected(3, 'Loop'),
    editRejected(3, 'AlreadyConnected'),
    editRejected(3, 'UnknownTarget'),
    editRejected(3, 'Loop'),
    editRejected(3, 'UnknownTarget'),
    editRejected(3, 'NotConnected'),
    editRejected(3, 'UnknownTarget')
  ])
})

test('the filter removed, the output hears the insert again', () => {
  const engine = startEngine({ initial: {} })
  const toned = changed(engine, addTone(emptyTestGraph))
  const filtered = changed(engine, addFilter(toned, { cutoff: 200 }))
  expect(engine.settledPeak()).toBeLessThan(fullVolumePeak / 2 / 4)
  changed(engine, removeFilter(filtered))
  expect(engine.settledPeak()).toBeCloseTo(fullVolumePeak / 2, 3)
  expect(engine.readEvents()).toEqual([])
})

test('an insert passes on the sum of what it hears', () => {
  const [first, second] = [NodeHandle(2), NodeHandle(3)]
  const engine = startEngine({
    initial: {
      edits: [
        createInsert(insert),
        ...[first, second].flatMap((node) => [
          createNode(plugins.tone, node),
          DeviceEdit.Connect({ from: node, to: insert })
        ]),
        DeviceEdit.SetOutput({ node: insert })
      ]
    }
  })
  // Two tones in phase: twice the one at its default volume.
  expect(engine.settledPeak()).toBeCloseTo(fullVolumePeak, 3)
  expect(engine.readEvents()).toEqual([])
})

test.each([undefined, 200])(
  'a connection undone fades out without a click, and one made again comes back from where it got, through a filter at %s',
  (cutoff) => {
    const engine = startEngine({ initial: toneThrough(cutoff) })
    const left = leftOf(engine)
    left(rampBlocks)
    const before = left(3)
    engine.send({ edits: [DeviceEdit.Disconnect({ from: tone, to: insert })] })
    const fading = left(rampBlocks / 2)
    engine.send({ edits: [DeviceEdit.Connect({ from: tone, to: insert })] })
    const back = left(2 * rampBlocks)
    engine.send({ edits: [DeviceEdit.Disconnect({ from: tone, to: insert })] })
    const gone = left(2 * rampBlocks)
    expectSmooth([...before, ...fading, ...back, ...gone])
    // Part of the way down, then all the way back up.
    const peakOf = (heard: ReadonlyArray<number>) => Math.max(...heard.slice(-128).map(Math.abs))
    expect(peakOf(fading)).toBeLessThan(peakOf(before) * 0.9)
    expect(peakOf(back)).toBeCloseTo(peakOf(before), 3)
    expect(peakOf(gone)).toBeLessThanOrEqual(leftAtTheEnd(cutoff))
    expect(engine.readEvents()).toEqual([])
    expect(engine.builder.collect()).toBe(0)
  }
)

test('the output hears the filter if there is one, otherwise the insert: set once by a change, and by a rebuild', () => {
  const outputs = ({ transaction }: TestGraphChange) =>
    (transaction.edits ?? []).filter(DeviceEdit.$is('SetOutput')).map(({ node }) => node)
  const heard = ({ graph }: TestGraphChange) => [Option.getOrElse(liveNode(graph.filter), () => graph.insert)]
  const drums = [{ hash: Sha256('0d'.repeat(32)) }]
  const toned = Option.getOrThrow(addTone(emptyTestGraph))
  const filtered = Option.getOrThrow(addFilter(toned.graph))
  const changes = [
    toned,
    filtered,
    Option.getOrThrow(addDrums(emptyTestGraph, drums, [])),
    Option.getOrThrow(addTone(Option.getOrThrow(addFilter(emptyTestGraph)).graph))
  ]
  expect(changes.map(outputs)).toEqual([...changes.slice(0, 3).map(heard), []])
  // The insert alone, without the filter, and with it.
  const graphs = [Option.getOrThrow(removeTone(toned.graph)).graph, toned.graph, filtered.graph]
  const rebuilt = graphs.map((graph) => rebuildGraph(graph, { tone: {}, filter: {}, drums, steps: [] }))
  expect(rebuilt.map(outputs)).toEqual(rebuilt.map(heard))
  expect(rebuilt.every(({ graph }) => graph.insert !== undefined)).toBe(true)
})
