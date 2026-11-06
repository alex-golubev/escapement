import { expect, test } from 'vitest'
import { startOf } from '../../src/ui/kit/menu'

test('a menu opens after what it opens from, or ends before it where it would run past the page, never off its edges', () => {
  // A point: after it, and ending at it by the far edge.
  expect(startOf(100, 100, 80, 1000)).toBe(100)
  expect(startOf(950, 950, 80, 1000)).toBe(870)
  // Under a control: below it, or over it by the foot of the page.
  expect(startOf(130, 100, 50, 1000)).toBe(130)
  expect(startOf(980, 950, 50, 1000)).toBe(900)
  // Just fits, 4 pixels off the edge; no room either way, against the near edge.
  expect(startOf(916, 916, 80, 1000)).toBe(916)
  expect(startOf(40, 40, 80, 100)).toBe(4)
  expect(startOf(0, 0, 200, 100)).toBe(4)
})
