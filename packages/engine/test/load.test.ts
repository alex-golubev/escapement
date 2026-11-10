import { Option } from 'effect'
import { expect, test } from 'vitest'
import { dspLoadReader } from '../src/load'
import { createLoadClock, loadClockViews, timeWord } from '../src/load-clock'
import {
  type BlockLoad,
  createTelemetryBoard,
  engineTelemetryWords,
  telemetryReader,
  telemetryWriter
} from '../src/telemetry'
import { tally } from '../src/worklet/engine-block'
import { startEngine } from './harness'

test('a block is timed between two readings of a running clock, into its burst: a new burst counts afresh', () => {
  const load = { burst: 0, busy: 0, blocks: 0, longest: 0 }
  tally(load, 1, 1_000_000, 1_000_250, true)
  tally(load, 1, 1_002_000, 1_002_500, true)
  expect(load).toEqual({ burst: 1, busy: 750, blocks: 2, longest: 500 })
  // At rest; started before the burst, or ended after it; the clock standing; its thread put off between.
  tally(load, 1, 0, 0, true)
  tally(load, 1, 0, 1_003_000, true)
  tally(load, 1, 1_004_000, 0, true)
  tally(load, 1, 1_005_000, 1_005_000, true)
  tally(load, 1, 1_006_000, 1_009_000, false)
  expect(load).toEqual({ burst: 1, busy: 750, blocks: 2, longest: 500 })
  // Round from the top of the microseconds' 32 bits.
  tally(load, 2, 2 ** 31 - 50, -(2 ** 31) + 50, true)
  expect(load).toEqual({ burst: 2, busy: 100, blocks: 1, longest: 100 })
})

test('with the clock at rest or standing, the worklet times none of its blocks', () => {
  const engine = startEngine()
  engine.peak()
  expect(engine.readTelemetry()?.load).toEqual({ burst: 0, busy: 0, blocks: 0, longest: 0 })
  Atomics.store(loadClockViews(engine.loadClock), timeWord, 1_234_500)
  engine.peak()
  expect(engine.readTelemetry()?.load.blocks).toBe(0)
})

/** A board after a block at 120 BPM, its load as given. */
const boardWith = (load: BlockLoad) => {
  const board = createTelemetryBoard()
  const words = new Uint32Array(engineTelemetryWords)
  words[0] = 1
  // The tempo's word, a float: a board with a tempo of 0 is read as none.
  new Float32Array(words.buffer, 40, 1).set([120])
  telemetryWriter(board)(words, 0, load)
  return telemetryReader(board)()
}

test("a burst's load reaches the page once, when its clock rests, the sound's breaks counted since the burst before", () => {
  const clock = createLoadClock()
  const loadOf = dspLoadReader(clock, 48_000)
  const broke = (board: ReturnType<typeof boardWith>, underruns: number) =>
    Option.map(loadOf.read(board, underruns), (load) => load.broke)
  // A block's time is 2666.7 µs at 48 kHz: 1000 is 37.5% of it, 2400 is 90%.
  const first = boardWith({ burst: 1, busy: 37_000, blocks: 37, longest: 2400 })
  Atomics.store(loadClockViews(clock), timeWord, 512_250)
  expect(loadOf.read(first, 0)).toEqual(Option.none())
  Atomics.store(loadClockViews(clock), timeWord, 0)
  // Breaks before the first burst read are none of its own.
  expect(loadOf.read(first, 2)).toEqual(Option.some({ share: 0.375, longest: 0.9, broke: false }))
  // A break the browser counts while the clock rests belongs to the next burst.
  expect(broke(first, 3)).toEqual(Option.some(false))
  expect(broke(boardWith({ burst: 2, busy: 3700, blocks: 37, longest: 200 }), 3)).toEqual(Option.some(true))
  expect(broke(boardWith({ burst: 3, busy: 3700, blocks: 37, longest: 200 }), 3)).toEqual(Option.some(false))
  // A burst of no block timed, as one its thread was put off through, leaves the one before: 100 µs a block, 3.75%.
  expect(loadOf.read(boardWith({ burst: 4, busy: 0, blocks: 0, longest: 0 }), 3)).toEqual(
    Option.some(expect.objectContaining({ share: expect.closeTo(0.0375, 9) }))
  )
  // Measuring stopped: nothing until a burst after it, and no break counted against the time before.
  loadOf.forget()
  expect(loadOf.read(boardWith({ burst: 3, busy: 3700, blocks: 37, longest: 200 }), 9)).toEqual(Option.none())
  expect(broke(boardWith({ burst: 5, busy: 3700, blocks: 37, longest: 200 }), 9)).toEqual(Option.some(false))
})
