import { expect, test } from 'vitest'
import { fittedSize, outgrown } from '../../src/ui/kit/fit'

test('a window grows or shrinks by what its body lacks or has spare, its padding kept on every side', () => {
  // The Channels window's body: 8 pixels of padding, the rows narrower than the window.
  expect(
    fittedSize({
      window: { width: 664, height: 250 },
      body: { width: 664, height: 221 },
      padding: 8,
      content: { width: 612, height: 198 },
      room: { width: 2000, height: 2000 }
    })
  ).toEqual({ width: 628, height: 243 })
  // A body too small for what is in it.
  expect(
    fittedSize({
      window: { width: 100, height: 100 },
      body: { width: 100, height: 71 },
      padding: 8,
      content: { width: 300, height: 120 },
      room: { width: 2000, height: 2000 }
    })
  ).toEqual({ width: 316, height: 165 })
})

test('a window fitted to more than the desk has room for stops at its edge', () => {
  expect(
    fittedSize({
      window: { width: 100, height: 100 },
      body: { width: 100, height: 71 },
      padding: 8,
      content: { width: 3000, height: 3000 },
      room: { width: 800, height: 600 }
    })
  ).toEqual({ width: 800, height: 600 })
})

test('a window grows along the sides it showed all of what is in it along, once it no longer does', () => {
  // The Channels window fitted to four rows, then a fifth.
  const body = { width: 628, height: 214 }
  const four = { width: 612, height: 198 }
  const five = { width: 612, height: 238 }
  expect(outgrown({ body, padding: 8, was: four, now: five })).toEqual({ width: false, height: true })
  // Left bigger, or smaller, along the side that grew.
  expect(outgrown({ body: { width: 628, height: 400 }, padding: 8, was: four, now: five }).height).toBe(false)
  expect(outgrown({ body: { width: 628, height: 100 }, padding: 8, was: four, now: five }).height).toBe(false)
  // Smaller than it was.
  expect(outgrown({ body, padding: 8, was: five, now: four })).toEqual({ width: false, height: false })
  // Wider and taller at once.
  expect(outgrown({ body, padding: 8, was: four, now: { width: 700, height: 238 } })).toEqual({
    width: true,
    height: true
  })
})
