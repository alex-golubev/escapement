import { describe, expect, it } from 'vitest'

import { formatClock } from './format'

/** A round rate, so that a span in seconds is a sample count anyone can check. */
const RATE = 10_000

describe('formatClock', () => {
  it('says nothing before a context has said what rate it opened at', () => {
    // Null is what the page holds until a start succeeds, and a clock guessing
    // 48 kHz through it would be right on most machines and quietly wrong on
    // the rest.
    expect(formatClock(48_000, null)).toBe('—')
  })

  it('refuses a rate of zero rather than dividing by it', () => {
    // An infinity formats without complaint, and `Infinity:NaN` on screen says
    // less than a dash does.
    expect(formatClock(48_000, 0)).toBe('—')
  })

  it('keeps the digits in their columns as the number moves under them', () => {
    expect(formatClock(RATE * 5, RATE)).toBe('0:05.000')
    expect(formatClock(RATE * 5 + 1, RATE)).toBe('0:05.000')
    expect(formatClock(RATE * 5.25, RATE)).toBe('0:05.250')
  })

  it('carries into the minute instead of reading sixty seconds past it', () => {
    // The defect this file was made for. Rounded after the split, the seconds
    // here come to `60.000` while the minutes are still 0, and the clock reads
    // `0:60.000` — which is a clock nobody would disbelieve.
    const span = 599_996 / RATE

    // The fixture has to be inside the window it is about: one that rounded to
    // 59.999 would pass with the guard removed and pass exactly as green.
    expect(span % 60).toBeGreaterThanOrEqual(59.9995)
    expect(span % 60).toBeLessThan(60)

    expect(formatClock(599_996, RATE)).toBe('1:00.000')
  })

  it('counts minutes past the first', () => {
    expect(formatClock(RATE * 754.5, RATE)).toBe('12:34.500')
  })
})
