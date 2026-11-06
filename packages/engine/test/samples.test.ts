import { plugins, Sha256 } from '@escapement/engine-description'
import { describe, expect, test } from 'vitest'
import { partLength } from '../src/build-thread/sample-queue'
import { DeviceEdit } from '../src/device-edits'
import { NodeHandle } from '../src/handles'
import { createNode } from '../src/plugins'
import type { SampleAnswer, StoreSample } from '../src/protocol'
import type { Rejection } from '../src/rejections'
import { filterEdits, fullVolumePeak, rampBlocks, runSteps, startEngine, type TestEngine } from './harness'

const kick = Sha256('89'.repeat(32))
const snare = Sha256('5e'.repeat(32))

const sound = (id: number, channels: ReadonlyArray<Float32Array>, sampleRate = 48_000, hash = kick): StoreSample => ({
  _tag: 'StoreSample',
  id,
  hash,
  sampleRate,
  channels
})

const ramp = (length: number) => Float32Array.from({ length }, (_, i) => i / length)

const stored = (id: number): SampleAnswer => ({ _tag: 'SampleStored', id })

const refused = (id: number, reason: Rejection): SampleAnswer => ({ _tag: 'SampleRefused', id, reason })

const mib = 2 ** 20

/** Frames of a mono sound that would leave the engine `spare` bytes, out of 64 MiB. */
const leaving = (engine: TestEngine, spare: number) => (64 * mib - engine.memory.buffer.byteLength - spare) / 4

describe('storing a sound', () => {
  test('takes a step to begin and one per part, and answers once the last part is in', () => {
    const engine = startEngine()
    engine.storeSample(sound(1, [ramp(partLength * 2 + 10), ramp(partLength * 2 + 10)]))
    const parts = 3 * 2
    Array.from({ length: parts }, () => engine.step())
    expect(engine.answers).toEqual([])
    engine.step()
    expect(engine.answers).toEqual([stored(1)])
    // A last look for another sound.
    expect(runSteps(engine)).toBe(1)
  })

  test('the same sound again is in at once, without a part', () => {
    const engine = startEngine()
    engine.storeSample(sound(1, [ramp(partLength + 1)]))
    engine.storeSample(sound(2, [ramp(partLength + 1)]))
    // Begin and two parts for the first, then only a begin for the second, and a last look for more.
    expect(runSteps(engine)).toBe(3 + 1 + 1)
    expect(engine.answers).toEqual([stored(1), stored(2)])
  })

  test('sounds are stored one after another, in the order sent', () => {
    const engine = startEngine()
    engine.storeSample(sound(1, [ramp(partLength * 2)]))
    engine.storeSample(sound(2, [ramp(10)], 48_000, snare))
    runSteps(engine)
    expect(engine.answers).toEqual([stored(1), stored(2)])
  })

  test('a sound without frames is in at once', () => {
    const engine = startEngine()
    engine.storeSample(sound(1, [new Float32Array(0)]))
    runSteps(engine)
    expect(engine.answers).toEqual([stored(1)])
  })

  test.each([
    ['a number that is not finite', [Float32Array.of(0.5, Number.NaN)], 48_000, 'InvalidValue'],
    [
      'infinity in the second channel',
      [ramp(3), Float32Array.of(0, Number.POSITIVE_INFINITY, 0)],
      48_000,
      'InvalidValue'
    ],
    ['three channels', [ramp(3), ramp(3), ramp(3)], 48_000, 'TooManyChannels'],
    ['another sample rate', [ramp(3)], 44_100, 'WrongSampleRate']
  ] as const)('refuses %s with its reason, and then stores the next sound right', (_, channels, sampleRate, reason) => {
    const engine = startEngine()
    engine.storeSample(sound(1, channels, sampleRate))
    engine.storeSample(sound(2, [ramp(3)]))
    runSteps(engine)
    expect(engine.answers).toEqual([refused(1, reason), stored(2)])
  })

  test('a NaN in the last part of a long sound refuses it there', () => {
    const engine = startEngine()
    const channel = ramp(partLength * 2 + 5)
    channel[partLength * 2 + 4] = Number.NaN
    engine.storeSample(sound(1, [channel]))
    expect(runSteps(engine)).toBe(1 + 3 + 1)
    expect(engine.answers).toEqual([refused(1, 'InvalidValue')])
  })

  test.each([
    ['larger than its memory', () => [2, 2 ** 29] as const],
    ['that would leave it less than 16 MiB', (engine: TestEngine) => [1, leaving(engine, 8 * mib)] as const]
  ])('a sound %s is out of memory, and the engine goes on', (_, size) => {
    const engine = startEngine({ maximumMemory: 1024 })
    const [channels, frames] = size(engine)
    expect(engine.samples.begin(kick, 48_000, channels, frames)).toBe('OutOfMemory')
    engine.storeSample(sound(1, [ramp(10)]))
    runSteps(engine)
    expect(engine.answers).toEqual([stored(1)])
    expect(engine.settledPeak()).toBeCloseTo(fullVolumePeak / 2, 3)
  })

  test('a sound that leaves the engine more than 16 MiB is taken', () => {
    const engine = startEngine({ maximumMemory: 1024 })
    const frames = leaving(engine, 24 * mib)
    expect(engine.samples.begin(kick, 48_000, 1, frames)).toBe(frames)
  })

  test('a batch sent while a large sound comes in is built before the next part', () => {
    const engine = startEngine()
    // 100 MB.
    const channel = ramp(25 * 1024 * 1024)
    engine.storeSample(sound(1, [channel]))
    engine.step()
    engine.step()
    const open = engine.settledPeak()
    engine.send({ edits: filterEdits(200) })
    expect(engine.settledPeak()).toBeLessThan(open / 4)
    expect(engine.answers).toEqual([])
    expect(runSteps(engine)).toBe(Math.ceil(channel.length / partLength) - 1 + 1)
    expect(engine.answers).toEqual([stored(1)])
  })

  test('a sound without channels is refused as malformed', () => {
    const engine = startEngine()
    engine.storeSample(sound(1, []))
    runSteps(engine)
    expect(engine.answers).toEqual([refused(1, 'Malformed')])
  })

  test.each([
    ['longer', [ramp(3), ramp(4)]],
    ['shorter', [ramp(4), ramp(3)]]
  ] as const)('a second channel %s than the first, which the page never sends, throws', (_, channels) => {
    const engine = startEngine()
    engine.storeSample(sound(1, channels))
    expect(() => runSteps(engine)).toThrow()
  })
})

describe('evicting a sound', () => {
  test('waits in line behind the sounds sent before it, so the next store copies the sound again', () => {
    const engine = startEngine()
    const channel = ramp(partLength * 2)
    engine.storeSample(sound(1, [channel]))
    engine.evictSample(kick)
    engine.storeSample(sound(2, [channel]))
    // Begin and two parts, the eviction, begin and two parts again, and a last look for more.
    expect(runSteps(engine)).toBe(3 + 1 + 3 + 1)
    expect(engine.answers).toEqual([stored(1), stored(2)])
  })

  test('takes a step of its own between a sound’s parts and the next sound', () => {
    const engine = startEngine()
    engine.storeSample(sound(1, [ramp(10)], 48_000, snare))
    runSteps(engine)
    engine.storeSample(sound(2, [ramp(partLength * 2)]))
    engine.evictSample(snare)
    expect(runSteps(engine)).toBe(3 + 1 + 1)
    expect(engine.samples.begin(snare, 48_000, 1, 10)).toBe(10)
  })

  /** Two sounds of this many frames don't fit in 64 MiB together, with the 16 MiB the engine keeps for itself. */
  const largeSound = (engine: TestEngine) => ramp(leaving(engine, 24 * mib))

  test('gives its memory back: a sound that didn’t fit is taken after it', () => {
    const engine = startEngine({ maximumMemory: 1024 })
    const channel = largeSound(engine)
    engine.storeSample(sound(1, [channel]))
    engine.storeSample(sound(2, [channel], 48_000, snare))
    runSteps(engine)
    expect(engine.answers).toEqual([stored(1), refused(2, 'OutOfMemory')])
    engine.evictSample(kick)
    engine.storeSample(sound(3, [channel], 48_000, snare))
    runSteps(engine)
    expect(engine.answers.slice(2)).toEqual([stored(3)])
  })

  test('held by a sampler, gives its memory back only once the sampler is gone', () => {
    const engine = startEngine({ maximumMemory: 1024, initial: {} })
    const channel = largeSound(engine)
    const sampler = NodeHandle(3)
    engine.storeSample(sound(1, [channel]))
    runSteps(engine)
    engine.send({
      edits: [createNode(plugins.sampler, sampler, {}, { sample: kick }), DeviceEdit.SetOutput({ node: sampler })]
    })
    engine.evictSample(kick)
    engine.storeSample(sound(2, [channel], 48_000, snare))
    runSteps(engine)
    expect(engine.answers).toEqual([stored(1), refused(2, 'OutOfMemory')])
    engine.send({ edits: [DeviceEdit.DestroyNode({ node: sampler })] })
    Array.from({ length: rampBlocks + 1 }, engine.peak)
    expect(engine.builder.collect()).toBe(0)
    engine.storeSample(sound(3, [channel], 48_000, snare))
    runSteps(engine)
    expect(engine.answers.slice(2)).toEqual([stored(3)])
    expect(engine.readEvents()).toEqual([])
  })
})
