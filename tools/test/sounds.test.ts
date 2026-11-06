import { Option } from 'effect'
import { describe, expect, test } from 'vitest'
import { encodeWav, peakLevel, quantize, type Recipe, recipes, render, sampleFile, sampleRate } from '../src/sounds.ts'

const recipe = (id: string): Recipe =>
  Option.getOrThrowWith(
    Option.fromUndefinedOr(recipes.find((recipe) => recipe.id === id)),
    () => new Error(`No recipe ${id}`)
  )

const at = (seconds: number) => Math.round(seconds * sampleRate)

/** The share of a stretch's energy above `hertz`, by a plain DFT. */
const shareAbove = (samples: Float64Array, hertz: number, from: number, size: number) => {
  const stretch = samples.subarray(from, from + size)
  const energy = Array.from({ length: size / 2 }, (_, bin) => {
    const [re, im] = stretch.reduce(
      ([re, im], sample, n) => {
        const angle = (2 * Math.PI * bin * n) / size
        return [re + sample * Math.cos(angle), im - sample * Math.sin(angle)]
      },
      [0, 0]
    )
    return re * re + im * im
  })
  const cut = Math.ceil((hertz * size) / sampleRate)
  const total = energy.reduce((sum, bin) => sum + bin, 0)
  return energy.slice(cut).reduce((sum, bin) => sum + bin, 0) / total
}

/** From zero crossings: a clean tone crosses twice a period. */
const frequency = (samples: Float64Array, from: number, to: number) => {
  const stretch = samples.subarray(from, to)
  const crossings = stretch.slice(1).filter((sample, i) => Math.sign(sample) !== Math.sign(stretch[i])).length
  return crossings / 2 / ((to - from) / sampleRate)
}

describe.each(recipes)('$name', (sound) => {
  const samples = render(sound)

  test('comes out the same on every run', () => {
    expect(sampleFile(sound)).toEqual(sampleFile(sound))
  })

  test('peaks at −1 dB, starts and ends at 0, and is finite throughout', () => {
    expect(samples.every(Number.isFinite)).toBe(true)
    const peak = samples.reduce((peak, sample) => Math.max(peak, Math.abs(sample)), 0)
    expect(peak).toBeCloseTo(peakLevel, 9)
    const pcm = quantize(samples)
    expect([pcm[0], pcm[pcm.length - 1]]).toEqual([0, 0])
  })

  test('is a mono 16-bit WAV at 48 kHz', () => {
    const bytes = sampleFile(sound)
    const view = new DataView(bytes.buffer)
    const text = (from: number) => String.fromCharCode(...bytes.subarray(from, from + 4))
    const dataBytes = samples.length * 2
    expect([text(0), text(8), text(12), text(36)]).toEqual(['RIFF', 'WAVE', 'fmt ', 'data'])
    expect(view.getUint32(4, true)).toBe(36 + dataBytes)
    expect(view.getUint16(20, true)).toBe(1)
    expect(view.getUint16(22, true)).toBe(1)
    expect(view.getUint32(24, true)).toBe(48_000)
    expect(view.getUint32(28, true)).toBe(96_000)
    expect(view.getUint16(32, true)).toBe(2)
    expect(view.getUint16(34, true)).toBe(16)
    expect(view.getUint32(40, true)).toBe(dataBytes)
    expect(bytes.length).toBe(44 + dataBytes)
  })
})

test('16-bit samples are written little-endian after the header', () => {
  const bytes = encodeWav(Int16Array.from([1, -2, 32767]))
  expect(Array.from(bytes.subarray(44))).toEqual([1, 0, 0xfe, 0xff, 0xff, 0x7f])
})

// Rough checks of each sound's character, so tuning a recipe can't quietly turn it into something else.

test('the kick is low, and its pitch falls', () => {
  const kick = render(recipe('kick'))
  expect(shareAbove(kick, 200, 0, 4096)).toBeLessThan(0.1)
  const early = frequency(kick, at(0.01), at(0.03))
  const late = frequency(kick, at(0.2), at(0.3))
  expect(early).toBeGreaterThan(1.5 * late)
  expect(late).toBeGreaterThan(45)
  expect(late).toBeLessThan(60)
})

test('the snare has both a low body and bright wires', () => {
  const snare = render(recipe('snare'))
  const bright = shareAbove(snare, 1000, 0, 4096)
  expect(bright).toBeGreaterThan(0.2)
  expect(bright).toBeLessThan(0.8)
})

test('the hat is nearly all above 5 kHz', () => {
  expect(shareAbove(render(recipe('hat')), 5000, 0, 4096)).toBeGreaterThan(0.9)
})

test('the clap is three bursts 10 ms apart', () => {
  const clap = render(recipe('clap'))
  // The loudest sample in each millisecond.
  const envelope = Array.from({ length: 40 }, (_, ms) =>
    clap.subarray(at(ms / 1000), at((ms + 1) / 1000)).reduce((peak, sample) => Math.max(peak, Math.abs(sample)), 0)
  )
  // A burst starts where the level jumps: noise is uneven, so a burst's own loudness tells little.
  const starts = Array.from(envelope.keys()).filter((ms) => ms === 0 || envelope[ms] > 4 * envelope[ms - 1])
  expect(starts).toEqual([0, 10, 20])
})
