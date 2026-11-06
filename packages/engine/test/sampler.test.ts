import { MidiKey, type Plugin, plugins, Sha256 } from '@escapement/engine-description'
import { Brand, Option } from 'effect'
import { describe, expect, test } from 'vitest'
import { Command, PageNote } from '../src/commands'
import { DeviceEdit } from '../src/device-edits'
import { NodeHandle } from '../src/handles'
import { createNode, sampleNumber } from '../src/plugins'
import {
  addDrums,
  addFilter,
  addTone,
  connectDrums,
  disconnectDrums,
  emptyTestGraph,
  followedBy,
  playDrum,
  rebuildGraph,
  removeDrums,
  removeFilter,
  resetGraph,
  type TestGraph,
  type TestGraphChange
} from './test-graph'
import { blocks, kick, kickSound, rampBlocks, rejected, startEngine, storeSound, type TestEngine } from './harness'

const sampler = NodeHandle(3)

/** A sampler on the output, silent until a note, once the output has risen. */
const withSampler = () => {
  const edits = [createNode(plugins.sampler, sampler, {}, { sample: kick }), DeviceEdit.SetOutput({ node: sampler })]
  const engine = startEngine({ initial: { edits } })
  expect(blocks(engine, rampBlocks).every((heard) => heard === 0)).toBe(true)
  return engine
}

const middleC = MidiKey(60)

/** For a key the page's type can't make, as another writer of the ring could. */
const anyKey = Brand.nominal<MidiKey>()

const noteOn = (velocity = 1, key = middleC, node = sampler) => ({
  commands: [Command.NoteOn({ node, key, velocity, note: PageNote(0) })]
})

describe('the sampler', () => {
  test('a note from the page plays its sound frame for frame at its velocity', () => {
    const engine = withSampler()
    expect(storeSound(engine, [kickSound()], kick)).toEqual({ _tag: 'SampleStored', id: 1 })
    engine.send(noteOn(0.5))
    const heard = blocks(engine, 5)
    expect(heard.subarray(0, 500)).toEqual(kickSound().map((number) => number * 0.5))
    expect(heard.subarray(500).every((sample) => sample === 0)).toBe(true)
    expect(engine.readEvents()).toEqual([])
  })

  test('made before its sound, it stays silent until the sound is stored, and the next note plays it', () => {
    const engine = withSampler()
    engine.send(noteOn())
    expect(blocks(engine, 5).every((heard) => heard === 0)).toBe(true)
    storeSound(engine, [kickSound()], kick)
    expect(blocks(engine, 5).every((heard) => heard === 0)).toBe(true)
    engine.send(noteOn())
    expect(blocks(engine, 5).subarray(0, 500)).toEqual(kickSound())
  })

  test('refuses notes a node can not take, by name', () => {
    const engine = withSampler()
    engine.send(noteOn(1, middleC, NodeHandle(30)))
    engine.send(noteOn(1, anyKey(128)))
    engine.send(noteOn(Number.NaN))
    engine.send({
      commands: Array.from({ length: 33 }, (_, i) =>
        Command.NoteOn({ node: sampler, key: middleC, velocity: 1, note: PageNote(i) })
      )
    })
    blocks(engine, 1)
    const reasons = ['UnknownTarget', 'InvalidValue', 'InvalidValue', 'TooManyNotes'] as const
    expect(engine.readEvents()).toEqual(reasons.map((reason) => rejected(reason)))
  })

  test("its description numbers its sample from 1; an ID it doesn't have doesn't compile, and throws for any plugin", () => {
    expect(plugins.sampler.samples).toEqual([{ id: 'sample', label: 'Sample' }])
    expect(sampleNumber(plugins.sampler, 'sample')).toBe(1)
    // @ts-expect-error A typo.
    expect(() => sampleNumber(plugins.sampler, 'sampel')).toThrow('Sampler has no sample sampel')
    // A function's result, so the type doesn't narrow to the tone.
    const anyPlugin = ((plugin: Plugin) => plugin)(plugins.tone)
    expect(() => createNode(anyPlugin, sampler, {}, { sample: kick })).toThrow('Test tone has no sample sample')
  })
})

describe("the debug page's drums", () => {
  const hashes = ['a1', 'b2', 'c3', 'd4'].map((byte) => Sha256(byte.repeat(32)))
  const drums = hashes.map((hash) => ({ hash }))
  /** Each drum's sound: a constant at its own level, long enough to fill the blocks a test hears. */
  const level = (drum: number) => 0.1 * (drum + 1)
  const soundOf = (drum: number) => [new Float32Array(4096).fill(level(drum))]

  const apply = (engine: TestEngine, change: Option.Option<TestGraphChange>): TestGraph => {
    const { graph, transaction } = Option.getOrThrow(change)
    expect(engine.send(transaction)).toBe(true)
    return graph
  }

  test('go into the insert, so the filter comes and goes while they play', () => {
    expect(Option.isNone(addDrums(emptyTestGraph, [], [])), 'nothing to add').toBe(true)
    const withDrums = Option.getOrThrow(addDrums(emptyTestGraph, drums, [])).graph
    expect(withDrums.insert).toBeDefined()
    expect(Option.isNone(addDrums(withDrums, drums, []))).toBe(true)
    const filtered = Option.getOrThrow(addFilter(withDrums)).graph
    expect(Option.isSome(removeFilter(filtered))).toBe(true)
    const without = Option.getOrThrow(removeDrums(withDrums)).graph
    expect(Option.isNone(playDrum(without, 0))).toBe(true)
    expect(Option.isNone(playDrum(resetGraph(withDrums).graph, 0))).toBe(true)
  })

  test('are disconnected from the insert and connected again, each once at a time', () => {
    const withDrums = Option.getOrThrow(addDrums(emptyTestGraph, drums, [])).graph
    expect(Option.isNone(connectDrums(withDrums)), 'connected already').toBe(true)
    const disconnected = Option.getOrThrow(disconnectDrums(withDrums))
    const { insert, drums: made } = withDrums
    const nodes = made?.nodes ?? []
    expect(nodes).toHaveLength(drums.length)
    expect(disconnected.transaction.edits).toEqual(
      nodes.map((from) => DeviceEdit.Disconnect({ from, to: insert ?? NodeHandle(0) }))
    )
    expect(Option.getOrThrow(connectDrums(disconnected.graph)).transaction.edits).toEqual(
      nodes.map((from) => DeviceEdit.Connect({ from, to: insert ?? NodeHandle(0) }))
    )
    expect(Option.isNone(disconnectDrums(disconnected.graph))).toBe(true)
    const rebuilt = rebuildGraph(disconnected.graph, { tone: {}, filter: {}, drums, steps: [] }).graph
    expect(Option.isSome(connectDrums(rebuilt)), 'a rebuild keeps them disconnected').toBe(true)
    expect(Option.isNone(disconnectDrums(Option.getOrThrow(removeDrums(withDrums)).graph))).toBe(true)
  })

  test('need their sounds stored when added and evicted when removed; a reset keeps them for the next graph', () => {
    const filtered = Option.getOrThrow(addFilter(emptyTestGraph))
    expect([filtered.store, filtered.evict]).toEqual([undefined, undefined])
    const added = Option.getOrThrow(addDrums(filtered.graph, drums, []))
    expect([added.store, added.evict]).toEqual([hashes, undefined])
    const removed = Option.getOrThrow(removeDrums(added.graph))
    expect([removed.store, removed.evict]).toEqual([undefined, hashes])
    const reset = resetGraph(added.graph)
    expect([reset.store, reset.evict]).toEqual([undefined, undefined])
    expect(Option.isNone(removeDrums(reset.graph)), 'gone with the reset').toBe(true)
  })

  test('changes made one after another ask for every sound either does; a rebuild asks for none', () => {
    const filtered = Option.getOrThrow(addFilter(emptyTestGraph))
    const added = followedBy(filtered, Option.getOrThrow(addDrums(filtered.graph, drums, [])))
    expect([added.store, added.evict]).toEqual([hashes, undefined])
    const toned = followedBy(added, Option.getOrThrow(addTone(added.graph)))
    expect([toned.store, toned.evict]).toEqual([hashes, undefined])
    const removed = Option.getOrThrow(removeDrums(added.graph))
    const again = followedBy(removed, Option.getOrThrow(addDrums(removed.graph, drums, [])))
    expect([again.store, again.evict]).toEqual([hashes, hashes])
    const rebuilt = rebuildGraph(added.graph, { tone: {}, filter: {}, drums, steps: [] })
    expect([rebuilt.store, rebuilt.evict]).toEqual([undefined, undefined])
  })

  test('each pad plays its own sound through the filter, once that sound is stored', () => {
    const engine = startEngine({ initial: {} })
    const filtered = apply(engine, addFilter(emptyTestGraph))
    const graph = apply(engine, addDrums(filtered, drums, []))
    blocks(engine, 2 * rampBlocks)
    const hit = (drum: number) => {
      engine.send(Option.getOrThrow(playDrum(graph, drum)))
      // The open filter leaves a constant as it is once it has settled.
      const heard = blocks(engine, 8)
      blocks(engine, 32)
      return heard[heard.length - 1]
    }
    expect(hit(0)).toBe(0)
    hashes.forEach((hash, drum) => storeSound(engine, soundOf(drum), hash))
    hashes.forEach((_, drum) => {
      expect(hit(drum)).toBeCloseTo(level(drum), 4)
    })
    expect(engine.readEvents()).toEqual([])
  })
})
