import { Option } from 'effect'
import { expect, test } from 'vitest'
import { Command, LoopTicks } from '../src/commands'
import { DeviceEdit } from '../src/device-edits'
import { live, rejected, startEngine, type TestEngine, toneEdits } from './harness'

const bar = LoopTicks(3840)
const play = Command.SetTransport({ playing: true, loopTicks: bar, arrangement: false })

/** The board after each of `blocks` blocks. */
const playheads = (engine: TestEngine, blocks: number) =>
  Array.from({ length: blocks }, () => {
    engine.peak()
    return Option.getOrUndefined(
      Option.map(Option.fromUndefinedOr(engine.readTelemetry()), ({ playing, position }) => [playing, position])
    )
  })

/** At `bpm` and 48 kHz, whole ticks at the start of each block from `from` on, within the bar. */
const ticksAt = (bpm: number, from: number, blocks: number, start = 0) =>
  Array.from({ length: blocks }, (_, i) => [
    true,
    (start + Math.floor(((from + i) * 128 * bpm * 960) / (60 * 48_000))) % bar
  ])

test('the board shows the playhead from the block the transport starts in', () => {
  const engine = startEngine({ initial: { commands: [Command.SetTempo({ bpm: 120 })] } })
  expect(playheads(engine, 2)).toEqual([
    [false, 0],
    [false, 0]
  ])
  engine.send(live(play))
  // A bar is 750 blocks at 120: past the loop's end and round again.
  expect(playheads(engine, 800)).toEqual(ticksAt(120, 0, 800))
  engine.send(live(Command.SetTransport({ playing: false, loopTicks: bar, arrangement: false })))
  expect(playheads(engine, 1)).toEqual([[false, 0]])
})

test('a new tempo changes the speed from its block, without a jump', () => {
  const engine = startEngine({ initial: { commands: [play] } })
  playheads(engine, 100)
  engine.send(live(Command.SetTempo({ bpm: 60 })))
  // 100 blocks at 120 are 512 ticks, and the new count goes on from there.
  expect(playheads(engine, 20)).toEqual(ticksAt(60, 0, 20, 512))
})

test('a rebuild that sends the same transport keeps the playhead going', () => {
  const engine = startEngine({ initial: { edits: toneEdits(), commands: [play] } })
  playheads(engine, 10)
  engine.send({ edits: [DeviceEdit.Reset({ epoch: 1 }), ...toneEdits()], commands: [play] })
  expect(playheads(engine, 5)).toEqual(ticksAt(120, 10, 5))
  expect(engine.readTelemetry()?.epoch).toBe(1)
  expect(engine.readEvents()).toEqual([])
})

test('a tempo that is not a number and a loop of no ticks are refused', () => {
  const engine = startEngine({ initial: {} })
  // Past the brand, as a page without types could send it.
  const noTicks = 0 as LoopTicks
  engine.send(
    live(
      Command.SetTempo({ bpm: Number.NaN }),
      Command.SetTransport({ playing: true, loopTicks: noTicks, arrangement: false })
    )
  )
  expect(playheads(engine, 1)).toEqual([[false, 0]])
  expect(engine.readEvents()).toEqual([rejected('InvalidValue'), rejected('InvalidValue')])
})
