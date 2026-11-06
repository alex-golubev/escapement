import { SoundStatus } from '@escapement/compiler'
import { Sha256 } from '@escapement/engine-description'
import { expect, test } from 'vitest'
import manifest from '../../../../samples/manifest.json'
import { LoadStatus, type SampleLine, sampleUrls, withStatus } from '../../src/services/samples'

const kick: SampleLine = { name: 'Kick', hash: Sha256('89'.repeat(32)), loads: 0, status: LoadStatus.NotLoaded() }
const snare: SampleLine = { name: 'Snare', loads: 0, status: LoadStatus.NotLoaded() }
const decoded = { seconds: 0.7, sha256: '89'.repeat(32) }

test('a load counts once, as it starts', () => {
  const loading = withStatus([kick, snare], 'Kick', LoadStatus.Loading())
  expect(loading).toEqual([{ ...kick, loads: 1, status: LoadStatus.Loading() }, snare])
  expect(withStatus(loading, 'Kick', LoadStatus.Storing({ decoded }))[0].loads).toBe(1)
  expect(withStatus(loading, 'Kick', SoundStatus.Stored())[0].loads).toBe(1)
})

test('what was decoded stays until another decode replaces it', () => {
  const stored = withStatus([kick], 'Kick', LoadStatus.Storing({ decoded }))
  expect(stored[0].decoded).toEqual(decoded)
  // The bad sample is stored with nothing decoded.
  expect(withStatus(stored, 'Kick', LoadStatus.Storing({}))[0].decoded).toEqual(decoded)
  expect(withStatus(stored, 'Kick', SoundStatus.Evicted())[0].decoded).toEqual(decoded)
  const again = { seconds: 0.5, sha256: 'ab'.repeat(32) }
  expect(withStatus(stored, 'Kick', LoadStatus.Storing({ decoded: again }))[0].decoded).toEqual(again)
})

test('a sample not among the lines comes last, and a known one keeps its place', () => {
  const lines = withStatus([kick, snare], 'Bad sample', LoadStatus.Loading())
  expect(lines.map(({ name }) => name)).toEqual(['Kick', 'Snare', 'Bad sample'])
  expect(lines[2]).toEqual({ name: 'Bad sample', loads: 1, status: LoadStatus.Loading() })
  expect(withStatus(lines, 'Snare', SoundStatus.Stored()).map(({ name, status }) => [name, status._tag])).toEqual([
    ['Kick', 'NotLoaded'],
    ['Snare', 'Stored'],
    ['Bad sample', 'Loading']
  ])
})

test("every sample of the manifest is found, with a URL to fetch it by: the glob's path is where the samples are", () => {
  expect(manifest.samples.length).toBeGreaterThan(0)
  expect(manifest.samples.filter(({ file }) => !sampleUrls.has(file)).map(({ file }) => file)).toEqual([])
})
