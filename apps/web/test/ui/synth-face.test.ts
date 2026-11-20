import { expect, test } from 'vitest'
import { envelopeLine } from '../../src/ui/views/track/synth-face'

const turned = (positions: {
  readonly delay: number
  readonly attack: number
  readonly hold: number
  readonly decay: number
  readonly sustain: number
  readonly release: number
}) =>
  envelopeLine(
    (param) =>
      ({
        'envelope.delay': positions.delay,
        'envelope.attack': positions.attack,
        'envelope.hold': positions.hold,
        'envelope.decay': positions.decay,
        'envelope.sustain': positions.sustain,
        'envelope.release': positions.release
      })[param]
  )

test("the envelope's line takes a sixth for each knob turned all the way, and a sixth for the sustain at its level", () => {
  expect(turned({ delay: 1, attack: 1, hold: 1, decay: 1, sustain: 1, release: 1 })).toBe(
    'M0 1 L1 1 L2 0 L3 0 L4 0 L5 0 L6 1'
  )
})

test('each stretch of the line is as long as its knob is turned, none for one turned down', () => {
  expect(turned({ delay: 0, attack: 0.25, hold: 0, decay: 0.5, sustain: 0.5, release: 0.75 })).toBe(
    'M0 1 L0 1 L0.25 0 L0.25 0 L0.75 0.5 L1.75 0.5 L2.5 1'
  )
})

test('the corners of the line are written to four places', () => {
  expect(turned({ delay: 1 / 3, attack: 0, hold: 0, decay: 0, sustain: 0, release: 0 })).toBe(
    'M0 1 L0.3333 1 L0.3333 0 L0.3333 0 L0.3333 1 L1.3333 1 L1.3333 1'
  )
})
