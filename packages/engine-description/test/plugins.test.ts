import { Array, Option } from 'effect'
import { describe, expect, test } from 'vitest'
import {
  defaultStrip,
  formatShort,
  formatValue,
  newTrackPosition,
  nearestIn,
  paramPosition,
  paramValue,
  pluginNameOf,
  plugins,
  strip,
  widestShort,
  widestText
} from '../src/plugins'

const [volume] = plugins.tone.params
const [cutoff] = plugins.filter.params
const [, pan] = strip
const synthParam = (id: string) => Option.getOrThrow(Array.findFirst(plugins.synth.params, (param) => param.id === id))
const [coarse, fine, mix] = [synthParam('osc2.coarse'), synthParam('osc2.fine'), synthParam('osc2.mix')]
const [delay, attack] = [synthParam('envelope.delay'), synthParam('envelope.attack')]
const params = [volume, cutoff, pan, delay, attack]

test('a project finds a plugin by its ID and version, and none this build lacks', () => {
  expect(pluginNameOf(plugins.sampler.id, plugins.sampler.version)).toEqual(Option.some('sampler'))
  expect(pluginNameOf(plugins.filter.id, plugins.filter.version)).toEqual(Option.some('filter'))
  expect(pluginNameOf(plugins.sampler.id, plugins.sampler.version + 1)).toEqual(Option.none())
  expect(pluginNameOf(0, 1)).toEqual(Option.none())
})

describe('a knob', () => {
  test('runs from the minimum to the maximum', () => {
    params.forEach((param) => {
      expect(paramValue(param, 0)).toBe(param.min)
      expect(paramValue(param, 1)).toBe(param.max)
      expect(paramPosition(param, param.min)).toBe(0)
      expect(paramPosition(param, param.max)).toBe(1)
    })
  })

  test('moves evenly in the value on a linear scale, and in octaves on a logarithmic one', () => {
    expect(paramValue(pan, 0.5)).toBeCloseTo(0, 9)
    expect(paramValue(pan, 0.75)).toBeCloseTo(0.5, 9)
    // 632 Hz: as many octaves above 20 Hz as below 20 kHz.
    expect(paramValue(cutoff, 0.5)).toBeCloseTo(Math.sqrt(20 * 20_000), 9)
    expect(paramValue(cutoff, 0.1) / cutoff.min).toBeCloseTo((cutoff.max / cutoff.min) ** 0.1, 9)
  })

  test("turns a volume finer near the top: 5.2 dB down where a new track's stands, silent at the bottom", () => {
    const decibelsAt = (position: number) => 20 * Math.log10(paramValue(volume, position))
    expect(newTrackPosition).toBe(0.78)
    expect(decibelsAt(newTrackPosition)).toBeCloseTo(-5.2, 9)
    expect(decibelsAt(1)).toBe(0)
    expect(decibelsAt(0.5)).toBeCloseTo(-14.5, 1)
    expect(decibelsAt(0.25)).toBeCloseTo(-29, 1)
    expect(paramValue(volume, 0)).toBe(0)
    // The same turn takes fewer decibels the higher it is.
    expect(decibelsAt(1) - decibelsAt(0.9)).toBeLessThan(decibelsAt(0.5) - decibelsAt(0.4))
  })

  test('turns a time finer near the bottom: half way up, a sixteenth of the way to 10 s', () => {
    expect(paramValue(delay, 0.5)).toBeCloseTo(0.625, 9)
    expect(paramValue(delay, 0.25)).toBeCloseTo(10 / 256, 9)
    // From its own least.
    expect(paramValue(attack, 0)).toBe(0.001)
    expect(paramValue(attack, 0.5)).toBeCloseTo(0.001 + 9.999 / 16, 9)
    // The same turn takes less time the lower it is.
    expect(paramValue(delay, 0.2) - paramValue(delay, 0.1)).toBeLessThan(
      paramValue(delay, 0.9) - paramValue(delay, 0.8)
    )
  })

  test('stands where its value takes it', () => {
    const positions = [0.13, 0.5, 0.87]
    params.forEach((param) =>
      positions.forEach((position) =>
        expect(paramPosition(param, paramValue(param, position))).toBeCloseTo(position, 9)
      )
    )
  })

  test('of whole numbers, reads the nearest, halves up, as the engine takes it', () => {
    expect(nearestIn(coarse, -11.5)).toBe(-11)
    expect(nearestIn(coarse, -11.6)).toBe(-12)
    expect(nearestIn(coarse, 2.5)).toBe(3)
    expect(nearestIn(coarse, 2.4)).toBe(2)
    expect(nearestIn(coarse, -30)).toBe(-24)
    expect(nearestIn(coarse, 30)).toBe(24)
  })

  test('of whole numbers, turns a step at a time', () => {
    expect(paramValue(coarse, 0.5)).toBe(0)
    // 47 of 48 steps, a little short.
    expect(paramValue(coarse, 0.97)).toBe(23)
    expect(paramValue(coarse, 0.99)).toBe(24)
    expect(paramPosition(coarse, -12)).toBe(0.25)
  })

  test('stays within its range', () => {
    expect(paramValue(cutoff, -1)).toBe(cutoff.min)
    expect(paramValue(cutoff, 2)).toBe(cutoff.max)
    expect(paramPosition(cutoff, 1)).toBe(0)
    expect(paramPosition(cutoff, 1e6)).toBe(1)
  })
})

test('a value reads in its unit', () => {
  expect(formatValue(cutoff, 356.4)).toBe('356 Hz')
  expect(formatValue(cutoff, 999.6)).toBe('1 kHz')
  expect(formatValue(cutoff, 2412)).toBe('2.4 kHz')
  expect(formatValue(cutoff, 20_000)).toBe('20 kHz')
  expect(formatValue({ unit: null, scale: 'linear', min: 0, max: 1, whole: false }, 0.5)).toBe('0.50')
  expect(formatValue(volume, 1)).toBe('0.0 dB')
  expect(formatValue(volume, paramValue(volume, newTrackPosition))).toBe('−5.2 dB')
  expect(formatValue(volume, 0.5)).toBe('−6.0 dB')
  expect(formatValue(volume, 0.9995)).toBe('0.0 dB')
  expect(formatValue({ ...volume, max: 2 }, 1.25)).toBe('+1.9 dB')
  // Down to where the engine takes it as 0.
  expect(formatValue(volume, 1e-15)).toBe('−300.0 dB')
  expect(formatValue(volume, 9e-16)).toBe('−∞ dB')
  expect(formatValue(volume, 0)).toBe('−∞ dB')
  expect(formatValue(pan, 0)).toBe('center')
  expect(formatValue(pan, 0.004)).toBe('center')
  expect(formatValue(pan, -0.25)).toBe('25% left')
  expect(formatValue(pan, 1)).toBe('100% right')
  expect(formatValue(coarse, -12)).toBe('−12 st')
  expect(formatValue(coarse, 0)).toBe('0 st')
  expect(formatValue(coarse, 7)).toBe('+7 st')
  expect(formatValue(fine, -35.4)).toBe('−35 ct')
  expect(formatValue(fine, -0.4)).toBe('0 ct')
  expect(formatValue(fine, 100)).toBe('+100 ct')
  expect(formatValue(mix, 0.5)).toBe('50%')
  expect(formatValue(mix, 1 / 3)).toBe('33%')
  expect(formatValue(mix, 0)).toBe('0%')
  expect(formatValue(delay, 0)).toBe('0 ms')
  expect(formatValue(delay, 0.00041)).toBe('0.4 ms')
  expect(formatValue(attack, 0.0025)).toBe('2.5 ms')
  expect(formatValue(attack, 0.003)).toBe('3 ms')
  expect(formatValue(attack, 0.00996)).toBe('10 ms')
  expect(formatValue(attack, 0.0254)).toBe('25 ms')
  expect(formatValue(attack, 0.9996)).toBe('1 s')
  expect(formatValue(attack, 1.24)).toBe('1.2 s')
  expect(formatValue(attack, 10)).toBe('10 s')
})

test('a value reads shorter where a pan is a side and how far, rounded as in full; anything else as in full', () => {
  expect(formatShort(pan, 0)).toBe('C')
  expect(formatShort(pan, -0.004)).toBe('C')
  expect(formatShort(pan, -0.14)).toBe('L14')
  expect(formatShort(pan, 0.225)).toBe('R23')
  expect(formatShort(pan, 1)).toBe('R100')
  expect(formatShort(volume, 0.5)).toBe('−6.0 dB')
  expect(formatShort(volume, 0)).toBe('−∞ dB')
  expect(formatShort(cutoff, 2412)).toBe('2.4 kHz')
})

test("a knob's widest number is the longest it reads anywhere along its travel", () => {
  expect(widestText(pan)).toBe('100% right'.length)
  expect(widestText(volume)).toBe('−100.0 dB'.length)
  expect(widestText(cutoff)).toBe('19.9 kHz'.length)
  expect(widestText(coarse)).toBe('+24 st'.length)
  expect(widestText(fine)).toBe('+100 ct'.length)
  expect(widestText(mix)).toBe('100%'.length)
  expect(widestText(attack)).toBe('999 ms'.length)
  expect(widestShort(pan)).toBe('R100'.length)
  expect(widestShort(volume)).toBe('−100.0 dB'.length)
})

test("a strip's volume leaves the sound as it is, its pan in the middle", () => {
  expect(defaultStrip).toEqual({ volume: 1, pan: 0 })
  expect(paramPosition(pan, 0)).toBe(0.5)
})
