import { Option } from 'effect'
import { expect, test } from 'vitest'
import { heardFrame, heardTick, heardTickReader, keepAudible, type Snapshot } from '../src/playhead'

const rate = 48_000
const bar = 3840
const playing = (frame: number, position: number, tempo = 120, loopTicks = bar, arrangement = false): Snapshot => ({
  frame,
  playing: true,
  position,
  loopTicks,
  arrangement,
  tempo
})
const stopped = (frame: number): Snapshot => ({
  frame,
  playing: false,
  position: 0,
  loopTicks: 0,
  arrangement: false,
  tempo: 120
})
const tickAt = (snapshots: ReadonlyArray<Snapshot>, frame: number) =>
  Option.getOrUndefined(Option.map(heardTick(snapshots, frame, rate), ({ tick }) => tick))

test('the heard tick counts on from the snapshot heard, at its tempo', () => {
  // A quarter of a second at 120 is 480 ticks, at 60 half that.
  expect(tickAt([playing(48_000, 1000)], 48_000)).toBe(1000)
  expect(tickAt([playing(48_000, 1000)], 60_000)).toBe(1480)
  expect(tickAt([playing(48_000, 1000, 60), playing(60_000, 1240, 240)], 60_000 - 1)).toBeCloseTo(1240, 1)
  expect(tickAt([playing(48_000, 1000, 60), playing(60_000, 1240, 240)], 60_000)).toBe(1240)
})

test('past the loop’s end the heard tick goes round from its start, the loop of the snapshot heard', () => {
  expect(tickAt([playing(0, bar - 240)], 12_000)).toBe(240)
  expect(tickAt([playing(0, bar - 240, 120, 2 * bar)], 12_000)).toBe(bar + 240)
  // Grown while it plays: the snapshot before is heard round its own, the one after round the new.
  const grown = [playing(0, bar - 240), playing(12_000, bar + 240, 120, 2 * bar)]
  expect(tickAt(grown, 11_999)).toBeCloseTo(240, 0)
  expect(tickAt(grown, 12_000)).toBe(bar + 240)
  expect(heardTick(grown, 11_999, rate)).toEqual(
    Option.some({ tick: expect.closeTo(240, 0), loop: bar, arrangement: false })
  )
  expect(heardTick(grown, 12_000, rate)).toEqual(Option.some({ tick: bar + 240, loop: 2 * bar, arrangement: false }))
})

test('the heard tick is of the arrangement while the snapshot heard plays it: what the page chose since is not heard yet', () => {
  const switched = [playing(0, 240), playing(12_000, 2 * bar + 720, 120, 4 * bar, true)]
  expect(heardTick(switched, 11_999, rate)).toEqual(
    Option.some({ tick: expect.closeTo(720, 0), loop: bar, arrangement: false })
  )
  expect(heardTick(switched, 12_000, rate)).toEqual(
    Option.some({ tick: 2 * bar + 720, loop: 4 * bar, arrangement: true })
  )
})

test('nothing is heard before the first block of the play is', () => {
  const snapshots = [stopped(0), playing(4096, 0)]
  expect(tickAt(snapshots, 4095)).toBeUndefined()
  expect(tickAt(snapshots, 4096)).toBe(0)
  expect(tickAt([playing(4096, 0)], 4000)).toBeUndefined()
})

test('the play is heard until its last block is', () => {
  const snapshots = [playing(0, 1000), stopped(12_000)]
  expect(tickAt(snapshots, 11_999)).toBeCloseTo(1480, 1)
  expect(tickAt(snapshots, 12_000)).toBeUndefined()
})

test('only the snapshot heard and those after it are kept, each block once', () => {
  const kept = [playing(0, 0), playing(1024, 40), playing(2048, 81)].reduce<ReadonlyArray<Snapshot>>(
    (snapshots, read) => keepAudible(snapshots, read, 1500),
    []
  )
  expect(kept.map(({ frame }) => frame)).toEqual([1024, 2048])
  expect(keepAudible(kept, playing(2048, 81), 1500)).toEqual(kept)
  expect(keepAudible([], playing(2048, 81), 0)).toEqual([playing(2048, 81)])
})

const context = (contextTime: number, performanceTime: number, currentTime: number) => ({
  getOutputTimestamp: () => ({ contextTime, performanceTime }),
  currentTime,
  sampleRate: rate
})

const frameAt = (output: ReturnType<typeof context>, now: number) => Option.getOrUndefined(heardFrame(output, now))

test('the frame heard counts on from the output’s timestamp, never past what is rendered', () => {
  expect(frameAt(context(0, 0, 0.01), 5000)).toBeUndefined()
  expect(frameAt(context(1, 5000, 1.1), 5000)).toBe(rate)
  expect(frameAt(context(1, 5000, 1.1), 5050)).toBeCloseTo(50_400)
  expect(frameAt(context(1, 5000, 1.1), 6000)).toBeCloseTo(52_800)
})

test('the tick heard is read from the snapshots kept, and none is kept before the output starts', () => {
  const output = { contextTime: 0, performanceTime: 0 }
  const tickHeard = heardTickReader({ getOutputTimestamp: () => output, currentTime: 10, sampleRate: rate })
  expect(tickHeard(playing(48_000, 1000), 5000)).toEqual(Option.none())
  output.contextTime = 1
  output.performanceTime = 5000
  expect(tickHeard(undefined, 5000), 'the snapshot before the output started is gone').toEqual(Option.none())
  expect(tickHeard(playing(48_000, 1000), 5000)).toEqual(Option.some({ tick: 1000, loop: bar, arrangement: false }))
  // A quarter of a second later, from the snapshot kept.
  expect(tickHeard(undefined, 5250)).toEqual(Option.some({ tick: 1480, loop: bar, arrangement: false }))
})
