import { ticksPerQuarter } from '@escapement/engine-description'
import { barTicks, stepBars, stepTicks } from '@escapement/model'
import { Option } from 'effect'
import { expect, test } from 'vitest'
import { followed } from '../../src/ui/parts/follow'
import { barsAcross, barsShown, barWidth, endOf, laneOf, stepsWidth, xOf } from '../../src/ui/windows/channels/geometry'
import { barGap, beatGap, stepGap, stepWidth } from '../../src/ui/windows/channels/layout'

test("a tick lies across the steps as they are laid out: a step's ticks across its pad, a gap's none", () => {
  expect(barWidth).toBe(16 * stepWidth + 12 * stepGap + 3 * beatGap)
  expect(xOf(0)).toBe(0)
  expect(xOf(stepTicks)).toBe(stepWidth + stepGap)
  expect(xOf(ticksPerQuarter)).toBe(4 * stepWidth + 3 * stepGap + beatGap)
  expect(xOf(barTicks)).toBe(barWidth + barGap)
  expect(xOf(3 * barTicks + stepTicks / 2)).toBe(3 * (barWidth + barGap) + stepWidth / 2)
  // What lasts to a step's start ends at the pad before it, not past the gap.
  expect(endOf(stepTicks)).toBe(stepWidth)
  expect(endOf(barTicks)).toBe(barWidth)
  expect(stepsWidth(1)).toBe(barWidth)
  expect(stepsWidth(3)).toBe(xOf(2 * barTicks) + barWidth)
})

test('the Channels window shows the bars of the pattern, one past it, and as many more as fit across its window, up to 32', () => {
  expect(barsAcross(stepsWidth(2))).toBe(2)
  expect(barsAcross(stepsWidth(2) - 1)).toBe(1)
  expect(barsAcross(0)).toBe(0)
  expect(barsShown(1, 0)).toBe(2)
  expect(barsShown(1, 5)).toBe(5)
  expect(barsShown(4, 2)).toBe(5)
  // 512 steps, however long the pattern or wide the window.
  expect(stepBars).toBe(32)
  expect(barsShown(31, 0)).toBe(32)
  expect(barsShown(10 ** 6, 0)).toBe(32)
  expect(barsShown(1, 100)).toBe(32)
})

test('the steps follow the playhead as the piano roll does: to the start of its bar as it leaves them by itself', () => {
  const twoBars = laneOf(0, stepsWidth(2))
  expect(followed(twoBars, Option.some(barTicks + stepTicks), barTicks + 2 * stepTicks, false)).toEqual(Option.none())
  expect(followed(twoBars, Option.some(2 * barTicks - 1), 2 * barTicks, false)).toEqual(Option.some(xOf(2 * barTicks)))
  expect(followed(laneOf(xOf(2 * barTicks), stepsWidth(2)), Option.some(4 * barTicks - 1), 0, false)).toEqual(
    Option.some(0)
  )
  // Scrolled by hand just then: the hand's.
  expect(followed(twoBars, Option.some(2 * barTicks - 1), 2 * barTicks, true)).toEqual(Option.none())
  // Narrower than a bar: from its beat.
  const beat = laneOf(0, xOf(ticksPerQuarter) + 10)
  expect(followed(beat, Option.some(ticksPerQuarter - 1), ticksPerQuarter + stepTicks, false)).toEqual(
    Option.some(xOf(ticksPerQuarter))
  )
})
