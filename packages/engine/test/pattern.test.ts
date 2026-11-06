import { MidiKey, plugins, Sha256, Tick } from '@escapement/engine-description'
import { Brand, Option } from 'effect'
import { describe, expect, test } from 'vitest'
import { Command, LoopTicks } from '../src/commands'
import { DeviceEdit } from '../src/device-edits'
import { handleOf, NodeHandle, PatternHandle } from '../src/handles'
import { createNode } from '../src/plugins'
import {
  addDrums,
  addFilter,
  addTone,
  drumsClips,
  drumsPattern,
  emptyTestGraph,
  isOn,
  patternLoop,
  rebuildGraph,
  removeDrums,
  setPattern,
  type Steps,
  stepTicks,
  type TestGraph,
  toggledStep
} from './test-graph'
import {
  blocks,
  blocksOf,
  editRejected,
  framesPerTick,
  kick,
  kickSound,
  rampBlocks,
  startEngine,
  storeSound
} from './harness'

const sampler = NodeHandle(1)
const middleC = MidiKey(60)
const play = Command.SetTransport({ playing: true, loopTicks: patternLoop, arrangement: false })
const loopFrames = patternLoop * framesPerTick

const note = (tick: number, node = sampler, key = middleC, velocity = 1) => ({
  tick: Tick(tick),
  node,
  key,
  velocity,
  length: stepTicks
})

/** The notes as the drums' pattern, played over and over. */
const played = (notes: ReadonlyArray<ReturnType<typeof note>>) => [
  DeviceEdit.SetPattern({ pattern: drumsPattern, notes }),
  drumsClips
]

/** Where a sound starts after silence: the sounds here are loud from their first frame. */
const onsets = (heard: Float32Array) =>
  Array.from(heard.keys()).filter((i) => Math.abs(heard[i]) > 1e-4 && (i === 0 || Math.abs(heard[i - 1]) < 1e-6))

/** A sampler playing the kick on the output, once the output has risen. */
const kickSampler = () => {
  const edits = [createNode(plugins.sampler, sampler, {}, { sample: kick }), DeviceEdit.SetOutput({ node: sampler })]
  const engine = startEngine({ initial: { edits } })
  expect(storeSound(engine, [kickSound()], kick)).toEqual({ _tag: 'SampleStored', id: 1 })
  blocks(engine, rampBlocks)
  return engine
}

describe('a pattern', () => {
  test('plays each note from the frame that passes its tick, from the block of Play and round the loop', () => {
    const engine = kickSampler()
    engine.send({ edits: played([note(1000), note(0)]), commands: [play] })
    const heard = blocks(engine, blocksOf(2 * loopFrames))
    const pass = [0, 1000 * framesPerTick]
    expect(onsets(heard)).toEqual([...pass, ...pass.map((frame) => frame + loopFrames)])
    expect(heard.subarray(0, 500)).toEqual(kickSound())
    expect(engine.readEvents()).toEqual([])
  })

  test('drops notes no note can have under one refusal, and the rest play', () => {
    const engine = kickSampler()
    // Past the page's types, as another writer could send them.
    const anyKey = Brand.nominal<MidiKey>()
    const notes = [note(0, sampler, anyKey(128)), note(0, sampler, middleC, Number.NaN), note(stepTicks)]
    engine.send({ edits: played(notes), commands: [play] })
    expect(onsets(blocks(engine, blocksOf(loopFrames)))).toEqual([stepTicks * framesPerTick])
    expect(engine.readEvents()).toEqual([editRejected(2, 'InvalidValue')])
  })

  test('naming a node that is gone after its batch is refused once, and the notes reach no node in its cell', () => {
    const engine = kickSampler()
    engine.send({ edits: played([note(stepTicks)]), commands: [play] })
    const again = handleOf(1, sampler)
    engine.send({
      edits: [
        DeviceEdit.DestroyNode({ node: sampler }),
        createNode(plugins.sampler, again, {}, { sample: kick }),
        DeviceEdit.SetOutput({ node: again })
      ]
    })
    expect(blocks(engine, blocksOf(loopFrames)).every((heard) => heard === 0)).toBe(true)
    expect(engine.readEvents()).toEqual([editRejected(3, 'UnknownTarget')])
  })
})

describe('an arrangement', () => {
  const other = PatternHandle(2)

  test("plays each clip's pattern from its tick, overlapping or not, and goes round at the loop's end", () => {
    const engine = kickSampler()
    engine.send({
      edits: [
        DeviceEdit.SetPattern({ pattern: drumsPattern, notes: [note(0)] }),
        DeviceEdit.SetPattern({ pattern: other, notes: [note(stepTicks)] }),
        DeviceEdit.SetClips({
          clips: [
            { tick: Tick(patternLoop), length: patternLoop, period: patternLoop, offset: 0, pattern: other },
            { tick: Tick(0), length: patternLoop, period: patternLoop, offset: 0, pattern: drumsPattern },
            { tick: Tick(0), length: stepTicks + 1, period: patternLoop, offset: 0, pattern: other }
          ]
        })
      ],
      commands: [Command.SetTransport({ playing: true, loopTicks: LoopTicks(2 * patternLoop), arrangement: false })]
    })
    const heard = blocks(engine, blocksOf(3 * loopFrames))
    const pass = [0, stepTicks, patternLoop + stepTicks].map((tick) => tick * framesPerTick)
    expect(onsets(heard)).toEqual([...pass, ...pass.map((frame) => frame + 2 * loopFrames)].slice(0, 5))
    expect(engine.readEvents()).toEqual([])
  })

  test('a clip longer than its period plays its pattern again each period, to its end', () => {
    const engine = kickSampler()
    engine.send({
      edits: [
        // The note at step 5 lies past the period: never heard.
        DeviceEdit.SetPattern({ pattern: drumsPattern, notes: [note(0), note(2 * stepTicks), note(5 * stepTicks)] }),
        // Rounds of four steps from steps 0, 4 and 8, the last cut short before its second note.
        DeviceEdit.SetClips({
          clips: [{ tick: Tick(0), length: 10 * stepTicks, period: 4 * stepTicks, offset: 0, pattern: drumsPattern }]
        })
      ],
      commands: [Command.SetTransport({ playing: true, loopTicks: LoopTicks(patternLoop), arrangement: false })]
    })
    const heard = blocks(engine, blocksOf(loopFrames))
    expect(onsets(heard)).toEqual([0, 2, 4, 6, 8].map((step) => step * stepTicks * framesPerTick))
    expect(engine.readEvents()).toEqual([])
  })

  test('a clip from an offset plays its pattern from there, and from its start each round after', () => {
    const engine = kickSampler()
    engine.send({
      edits: [
        DeviceEdit.SetPattern({ pattern: drumsPattern, notes: [note(0), note(3 * stepTicks)] }),
        // Rounds of four steps from the pattern's third: its steps 3 and 4 first, then 1 to 4.
        DeviceEdit.SetClips({
          clips: [
            {
              tick: Tick(0),
              length: 6 * stepTicks,
              period: 4 * stepTicks,
              offset: 2 * stepTicks,
              pattern: drumsPattern
            }
          ]
        })
      ],
      commands: [Command.SetTransport({ playing: true, loopTicks: LoopTicks(patternLoop), arrangement: false })]
    })
    const heard = blocks(engine, blocksOf(loopFrames))
    expect(onsets(heard)).toEqual([1, 2, 5].map((step) => step * stepTicks * framesPerTick))
    expect(engine.readEvents()).toEqual([])
  })

  test('naming a pattern that is gone after its batch is refused once, and its clips fall silent', () => {
    const engine = kickSampler()
    engine.send({ edits: played([note(stepTicks)]), commands: [play] })
    engine.send({ edits: [DeviceEdit.DestroyPattern({ pattern: drumsPattern })] })
    expect(blocks(engine, blocksOf(loopFrames)).every((heard) => heard === 0)).toBe(true)
    expect(engine.readEvents()).toEqual([editRejected(3, 'UnknownTarget')])
  })
})

describe("the page's steps", () => {
  const drums = [Sha256('01'.repeat(32)), Sha256('02'.repeat(32))].map((hash) => ({ hash }))
  const steps: Steps = [
    { drum: 1, step: 4 },
    { drum: 0, step: 0 }
  ]
  const withFilter = Option.getOrThrow(addFilter(emptyTestGraph)).graph

  test('switch on and off', () => {
    const on = toggledStep(steps, { drum: 0, step: 8 })
    expect(isOn(on, { drum: 0, step: 8 })).toBe(true)
    expect(isOn(toggledStep(on, { drum: 0, step: 8 }), { drum: 0, step: 8 })).toBe(false)
    expect(toggledStep(on, { drum: 0, step: 8 })).toEqual(steps)
  })

  test('go to the engine as the drums pattern: with the drums, and as nothing once they are gone', () => {
    expect(Option.isNone(setPattern(withFilter, steps))).toBe(true)
    const added = Option.getOrThrow(addDrums(withFilter, drums, steps))
    const [first, second] = added.graph.drums?.nodes ?? []
    const pattern = DeviceEdit.SetPattern({
      pattern: drumsPattern,
      notes: [note(4 * stepTicks, second), note(0, first)]
    })
    expect(added.transaction.edits?.slice(-2)).toEqual([pattern, drumsClips])
    expect(Option.getOrThrow(setPattern(added.graph, steps))).toEqual({ edits: [pattern] })
    const removed = Option.getOrThrow(removeDrums(added.graph))
    expect(removed.transaction.edits?.at(-1)).toEqual(DeviceEdit.SetPattern({ pattern: drumsPattern, notes: [] }))
  })

  test('keep their beat through a rebuild while playing, with no refusal', () => {
    const engine = startEngine({ initial: {} })
    drums.forEach(({ hash }, drum) => storeSound(engine, [new Float32Array(500).fill(0.1 * (drum + 1))], hash))
    const send = (change: { readonly graph: TestGraph; readonly transaction: object }) => {
      expect(engine.send(change.transaction)).toBe(true)
      return change.graph
    }
    const filtered = send(Option.getOrThrow(addFilter(emptyTestGraph)))
    const toned = send(Option.getOrThrow(addTone(filtered, { volume: 0 })))
    const graph = send(Option.getOrThrow(addDrums(toned, drums, steps)))
    engine.send({ commands: [play] })
    // Before step 4, which comes once the rebuilt nodes have risen.
    const played = 30 * 128
    blocks(engine, 30)
    const rebuilt = rebuildGraph(graph, { tone: { volume: 0 }, filter: {}, drums, steps })
    send(rebuilt)
    const heard = blocks(engine, blocksOf(loopFrames))
    const frame = (tick: number) => tick * framesPerTick - played
    expect(onsets(heard)).toEqual([frame(4 * stepTicks), frame(patternLoop)])
    expect(engine.readTelemetry()?.epoch).toBe(1)
    expect(engine.readEvents()).toEqual([])
  })
})
