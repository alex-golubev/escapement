import { expect, test } from 'vitest'
import {
  createTelemetryBoard,
  engineTelemetryWords,
  type MeterReading,
  telemetryReader,
  telemetryWriter
} from '../src/telemetry'
import { handleOf } from '../src/handles'
import { meterCount } from '../src/protocol'

const engineWords = (
  counts: readonly [blocks: number, epoch: number, lostEvents: number, lostNotes: number, heapCalls: number],
  peaks: readonly [number, number],
  [playing, position, loopTicks, tempo, streamLost]: readonly [number, number, number, number, number] = [
    0, 0, 0, 120, 0
  ],
  overs: readonly [number, number] = [0, 0],
  meters: ReadonlyArray<MeterReading> = []
) => {
  const words = new Uint32Array(engineTelemetryWords)
  words.set(counts)
  new Float32Array(words.buffer, 20, 2).set(peaks)
  words.set([playing, position, loopTicks], 7)
  new Float32Array(words.buffer, 40, 1).set([tempo])
  words.set([streamLost, ...overs, meters.length], 11)
  meters.forEach(({ node, peaks, overs }, i) => {
    const at = 15 + i * 5
    words.set([node], at)
    new Float32Array(words.buffer, (at + 1) * 4, 2).set(peaks)
    words.set(overs, at + 3)
  })
  return words
}

test('the page reads what the worklet wrote', () => {
  const board = createTelemetryBoard()
  // Past 32 bits: a day and more at 48 kHz.
  const frame = 2 ** 32 + 5 * 128
  telemetryWriter(board)(engineWords([42, 3, 2, 7, 1], [0.5, 0.25], [1, 1234, 7680, 128.5, 1], [9, 2 ** 32 - 1]), frame)
  expect(telemetryReader(board)()).toEqual({
    blocks: 42,
    epoch: 3,
    lostEvents: 2,
    lostNotes: 7,
    heapCalls: 1,
    peaks: [0.5, 0.25],
    playing: true,
    position: 1234,
    loopTicks: 7680,
    tempo: 128.5,
    streamLost: true,
    overs: [9, 2 ** 32 - 1],
    meters: [],
    frame
  })
})

test("the meters in use reach the page, each under its node's handle, and the worklet copies only those", () => {
  const board = createTelemetryBoard()
  const meters = [
    { node: handleOf(0, 7), peaks: [0.5, 0.25], overs: [3, 0] },
    { node: handleOf(0xffff, 0xffff), peaks: [1.5, 0], overs: [0, 2 ** 32 - 1] }
  ] as const
  const written = engineWords([1, 1, 0, 0, 0], [0.5, 0.5], undefined, undefined, meters)
  // A record past the count, as one left from a node gone.
  written.set([9, 0, 0, 1, 1], 15 + 2 * 5)
  // The board's words past what a write copies keep what they had.
  const words = new Uint32Array(board)
  words.fill(0xdead, 1 + 15 + 2 * 5)
  telemetryWriter(board)(written, 0)
  expect(telemetryReader(board)()?.meters).toEqual(meters)
  expect(words[1 + 15 + 2 * 5]).toBe(0xdead)
  // However many the engine says it has, no more than there are.
  written.set([meterCount + 1], 14)
  telemetryWriter(board)(written, 0)
  expect(telemetryReader(board)()?.meters).toHaveLength(meterCount)
})

test('a read that catches the worklet mid-write is not returned', () => {
  const board = createTelemetryBoard()
  telemetryWriter(board)(engineWords([1, 1, 0, 0, 0], [0.5, 0.5]), 0)
  // Odd: the worklet is mid-write.
  Atomics.add(new Uint32Array(board), 0, 1)
  expect(telemetryReader(board)()).toBeUndefined()
})
