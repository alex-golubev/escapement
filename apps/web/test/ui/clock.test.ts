import { ticksPerQuarter } from '@escapement/engine-description'
import { barTicks } from '@escapement/model'
import { expect, test } from 'vitest'
import { positionText, timeText } from '../../src/ui/screens/project/clock'

test('a position is its bar and beat from 1 and its tick in the beat, a part of a tick left out', () => {
  expect(positionText(0)).toEqual({ bar: '001', beat: '01', tick: '000' })
  expect(positionText(116 * barTicks + 2 * ticksPerQuarter + 120.9)).toEqual({ bar: '117', beat: '03', tick: '120' })
  expect(positionText(barTicks - 1)).toEqual({ bar: '001', beat: '04', tick: '959' })
})

test('a time is in minutes, seconds and milliseconds at the tempo, the minutes going on past an hour', () => {
  expect(timeText(0, 120)).toBe('00:00.000')
  expect(timeText(65 * 2 * ticksPerQuarter + ticksPerQuarter, 120)).toBe('01:05.500')
  expect(timeText(61 * 60 * ticksPerQuarter, 60)).toBe('61:00.000')
  // A part of a millisecond is left out: 1 tick at 120 is 0.52 ms.
  expect(timeText(1, 120)).toBe('00:00.000')
})
