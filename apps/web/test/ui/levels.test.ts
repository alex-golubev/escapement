import { expect, test } from 'vitest'
import { peakChars, peakText } from '../../src/ui/parts/levels'

/** A peak this many decibels from full scale. */
const atDb = (db: number) => 10 ** (db / 20)

test('a peak reads in decibels to a tenth, silence below the floor, never wider than its place', () => {
  expect(peakText(0)).toBe('−∞ dB')
  expect(peakText(atDb(-61))).toBe('−∞ dB')
  expect(peakText(atDb(-19.3))).toBe('−19.3 dB')
  expect(peakText(atDb(3.7))).toBe('+3.7 dB')
  // As wide as the floor's and the loudest's own.
  expect(peakChars).toBe('−59.9 dB'.length)
  expect(peakText(atDb(99.9)).length).toBe(peakChars)
})
