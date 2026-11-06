import { Option } from 'effect'
import { expect, test } from 'vitest'
import { playbackStatsOf } from '../src/playback-stats'

const contextWith = (playbackStats: unknown) => ({ playbackStats })

test('a browser without playback statistics reports none', () => {
  expect(playbackStatsOf({})).toEqual(Option.none())
})

test('statistics without the expected numbers count as none', () => {
  expect(playbackStatsOf(contextWith({}))).toEqual(Option.none())
  expect(playbackStatsOf(contextWith({ underrunEvents: 1, underrunDuration: '0.01' }))).toEqual(Option.none())
  expect(playbackStatsOf(contextWith(null))).toEqual(Option.none())
})

test("the browser's live object is handed out as it is", () => {
  const live = { underrunEvents: 0, underrunDuration: 0, totalDuration: 1 }
  expect(Option.getOrThrow(playbackStatsOf(contextWith(live)))).toBe(live)
})
