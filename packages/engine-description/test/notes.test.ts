import { expect, test } from 'vitest'
import { lastTick, MidiKey, Tick } from '../src/notes'

test('a tick is a whole number from 0 that fits 32 bits, so the engine takes it as itself', () => {
  expect([0, 240, lastTick].map(Tick)).toEqual([0, 240, 0xffff_ffff])
  const notTicks = [-1, 2 ** 32, 0.5, Number.NaN, Number.POSITIVE_INFINITY]
  notTicks.forEach((tick) => expect(() => Tick(tick)).toThrow('not a tick'))
})

test('a MIDI key is a whole number from 0 to 127, so it fits its byte as itself', () => {
  expect([0, 60, 127].map(MidiKey)).toEqual([0, 60, 127])
  const notKeys = [128, 316, -1, 60.5, Number.NaN]
  notKeys.forEach((key) => expect(() => MidiKey(key)).toThrow('not a MIDI key'))
})
