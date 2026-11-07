import { Option } from 'effect'
import { expect, test } from 'vitest'
import { HoldTarget, heldOver, heldValue, holding, Id, lettingGo, noHolds, readHolds } from '../src'

const kick = HoldTarget.TrackParam({ track: Id('kick'), param: 'volume' })
const kickPan = HoldTarget.TrackStrip({ track: Id('kick'), param: 'pan' })
const tempo = HoldTarget.Tempo()

test('a control is held at its latest value, apart from the others, until it is let go', () => {
  const held = holding(
    holding(holding(noHolds, kick, 0.5), tempo, 130),
    HoldTarget.TrackParam({ track: Id('kick'), param: 'volume' }),
    0.6
  )
  expect(held).toHaveLength(2)
  expect(heldValue(held, kick)).toEqual(Option.some(0.6))
  expect(heldValue(held, tempo)).toEqual(Option.some(130))
  expect(heldValue(held, HoldTarget.TrackParam({ track: Id('snare'), param: 'volume' }))).toEqual(Option.none())
  const rest = lettingGo(held, kick)
  expect(heldValue(rest, kick)).toEqual(Option.none())
  expect(heldValue(rest, tempo)).toEqual(Option.some(130))
})

const cutoff = HoldTarget.SlotParam({ slot: Id('filter'), param: 'cutoff' })

test("a client's own holds play over others'; of others' for one control, the first", () => {
  const own = holding(noHolds, kick, 0.2)
  const others = [
    { target: kick, value: 0.9 },
    { target: tempo, value: 140 },
    { target: tempo, value: 90 }
  ]
  expect(heldOver(own, others)).toEqual([
    { target: kick, value: 0.2 },
    { target: tempo, value: 140 }
  ])
  expect(heldOver(noHolds, others)).toEqual([
    { target: kick, value: 0.9 },
    { target: tempo, value: 140 }
  ])
})

test("another client's holds are read as it sent them, as targets this client compares", () => {
  const held = holding(holding(holding(holding(noHolds, kick, 0.5), cutoff, 800), tempo, 130), kickPan, -0.25)
  const read = readHolds(JSON.parse(JSON.stringify(held)))
  expect(read).toEqual([
    { target: kick, value: 0.5 },
    { target: cutoff, value: 800 },
    { target: tempo, value: 130 },
    { target: kickPan, value: -0.25 }
  ])
  expect(heldValue(read, HoldTarget.TrackParam({ track: Id('kick'), param: 'volume' }))).toEqual(Option.some(0.5))
})

test("another client's holds of the mixer are read as it sent them", () => {
  const fader = HoldTarget.InsertStrip({ insert: Id('3'), param: 'volume' })
  const route = HoldTarget.TrackInsert({ track: Id('kick') })
  const read = readHolds(JSON.parse(JSON.stringify(holding(holding(noHolds, fader, 1.5), route, 3))))
  expect(read).toEqual([
    { target: fader, value: 1.5 },
    { target: route, value: 3 }
  ])
  expect(
    readHolds([
      { target: { _tag: 'InsertStrip', insert: '3', param: 'cutoff' }, value: 1 },
      { target: { _tag: 'InsertStrip', insert: '', param: 'pan' }, value: 1 },
      { target: { _tag: 'TrackInsert' }, value: 2 }
    ])
  ).toEqual([])
})

test('what is not a hold of a control some plugin or the strip has, or of the tempo, with a number, is left out; of two, the first', () => {
  expect(readHolds(undefined)).toEqual([])
  expect(readHolds('holds')).toEqual([])
  expect(readHolds({ 0: { target: { _tag: 'Tempo' }, value: 120 } })).toEqual([])
  expect(
    readHolds([
      { target: { _tag: 'Tempo' }, value: 'fast' },
      { target: { _tag: 'Tempo' }, value: Number.NaN },
      { target: { _tag: 'Tempo' } },
      { target: { _tag: 'Swing' }, value: 1 },
      { target: { _tag: 'TrackParam', track: 'kick', param: 'feedback' }, value: 1 },
      { target: { _tag: 'TrackParam', track: '', param: 'volume' }, value: 1 },
      { target: { _tag: 'TrackStrip', track: 'kick', param: 'cutoff' }, value: 1 },
      { target: { _tag: 'TrackStrip', track: 'kick', param: 'pan' }, value: 0.5 },
      { target: { _tag: 'SlotParam', param: 'cutoff' }, value: 1 },
      null,
      7,
      { target: { _tag: 'TrackParam', track: 'kick', param: 'volume' }, value: 0.3 },
      { target: { _tag: 'TrackParam', track: 'kick', param: 'volume' }, value: 0.4 },
      { target: { _tag: 'Tempo' }, value: 999 }
    ])
  ).toEqual([
    { target: kickPan, value: 0.5 },
    { target: kick, value: 0.3 },
    { target: tempo, value: 999 }
  ])
})
