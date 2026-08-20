// The load path, which runs between quanta and is the only thing in the worklet
// that grows linear memory.
//
// Everything here goes through a fake engine, and the reason is the same one
// `openEngine` takes exports rather than a module for: the real artifact grants
// every reservation and accepts every sample, so a refusal is a thing only a
// stand-in will do on demand. What the real one is held to instead is
// `tests/engine-abi.spec.ts`, where a kit goes into the compiled engine and
// comes back out as sound.

import { describe, expect, it } from 'vitest'

import { createRing, openRing } from '../audio/ring'
import { openEngine } from './engine'
import type { EngineExports } from './engine'
import { answerKitMessage, describeKitError, loadKit } from './kit'
import type { KitError } from './kit'
import { refreshViews } from './render'
import type { KitSample } from '../audio/worklet-messages'
import { FAKE_LAYOUT, fakeEngine } from '../../tests/support/engine-fake'
import { unwrapError, unwrapValue } from '../../tests/support/unwrap'

const QUANTUM = FAKE_LAYOUT.quantum
const SAMPLE_RATE = 44100

describe('loadKit', () => {
  it('writes the samples end to end and declares each where it was written', () => {
    // The whole layout in one assertion, because the parts of it fail
    // separately: an offset counted in frames rather than in floats puts the
    // stereo sample below on top of its neighbour, and every sample still
    // sounds — quietly wrong, and only on kits that are not all mono.
    const reserved: number[] = []
    const declared: number[][] = []
    const { engine, state } = opened({
      engine_bank_reserve: (_instance, floats) => {
        reserved.push(floats)
        return FAKE_LAYOUT.arena
      },
      engine_sample_commit: (_instance, slot, offset, frames, channels) => {
        declared.push([slot, offset, frames, channels])
        return 0
      },
    })

    const loaded = unwrapValue(
      loadKit(state, [sample(1, 1, 2, 3), sample(2, 4, 5, 6, 7), sample(1, 8)]),
    )

    // The two fields this test is about, rather than the whole reading. `bytes`
    // is in there too and is a fact about linear memory instead of about the
    // layout — asserted here it would put this test in the way of anything that
    // changes how much memory a load takes, which is not its subject.
    expect(loaded.slots).toBe(3)
    expect(loaded.floats).toBe(8)
    expect(reserved, 'the arena was not asked for the sum of the kit').toEqual([8])
    expect(Array.from(arenaOf(engine, 8))).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(declared).toEqual([
      [0, 0, 3, 1],
      [1, 3, 2, 2],
      [2, 7, 1, 1],
    ])
  })

  it('builds its view on the memory the reservation left, not the one before it', () => {
    // The reason `refreshViews` exists, met head on. A reservation that grows
    // linear memory detaches every view over it, so a view built from a buffer
    // read before that call is dead by the time anything is written through it
    // — and writing through a detached view throws, out of a message handler,
    // where nothing is listening.
    const engine = fakeEngine()
    const grows: EngineExports = {
      ...engine,
      engine_bank_reserve: (_instance, floats) => {
        if (floats > 0) engine.memory.grow(1)
        return FAKE_LAYOUT.arena
      },
    }
    const state = unwrapValue(openEngine(grows, ring(), SAMPLE_RATE, QUANTUM))

    unwrapValue(loadKit(state, [sample(1, 9, 8, 7)]))

    expect(Array.from(arenaOf(grows, 3))).toEqual([9, 8, 7])
  })

  it('leaves the render path to rebuild what the reservation detached', () => {
    // The other half of the same event, and the half that runs a quantum later.
    // The load does not repair `EngineState` and must not: the views are the
    // render path's, and the render path checks them on every block anyway.
    const engine = fakeEngine()
    const grows: EngineExports = {
      ...engine,
      engine_bank_reserve: () => {
        engine.memory.grow(1)
        return FAKE_LAYOUT.arena
      },
    }
    const state = unwrapValue(openEngine(grows, ring(), SAMPLE_RATE, QUANTUM))
    expect(refreshViews(state), 'the views needed rebuilding before anything happened').toBe(
      state,
    )

    unwrapValue(loadKit(state, [sample(1, 1)]))

    const refreshed = refreshViews(state)
    // Compared as a boolean, and it has to be: after the growth `state` holds a
    // detached view, and handing that to a matcher walks it while the message
    // is built — which throws before the assertion is ever decided. The rule
    // reaches past this line, because everything reachable from an
    // `EngineState` older than a load is in that condition.
    expect(refreshed === state, 'the load left views nobody had to rebuild').toBe(false)
    expect(refreshed.views.outL.byteLength, 'the rebuilt view is not usable').toBeGreaterThan(0)
  })

  it('reports a refused arena with the size that was refused', () => {
    // The one refusal whose cause is not in its arguments, and the only one the
    // page can act on: it is the size that was too much, so the size is what
    // travels.
    const { state } = opened({ engine_bank_reserve: () => 0 })

    const error = unwrapError(loadKit(state, [sample(1, 1, 2), sample(2, 3, 4, 5, 6)]))

    expect(error).toEqual({ kind: 'refused-arena', floats: 6 })
  })

  it('drops the whole kit when one sample is refused', () => {
    // Not the slot that failed: what was asked for is a kit, and half of one is
    // a state with no name — the page holding a failure while the engine sounds
    // part of it. The second reservation, for nothing, is how the bank is told
    // it holds nothing.
    const reserved: number[] = []
    const { state } = opened({
      engine_bank_reserve: (_instance, floats) => {
        reserved.push(floats)
        return FAKE_LAYOUT.arena
      },
      engine_sample_commit: (_instance, slot) => (slot === 1 ? 4 : 0),
    })

    const error = unwrapError(
      loadKit(state, [sample(1, 1, 2), sample(3, 3, 4, 5), sample(1, 6)]),
    )

    expect(error).toEqual({
      kind: 'refused-sample',
      code: 4,
      slot: 1,
      offset: 2,
      frames: 1,
      channels: 3,
      floats: 6,
    })
    expect(reserved, 'the kit was left half loaded').toEqual([6, 0])
  })

  it('stops at the sample that was refused rather than declaring the rest', () => {
    const declared: number[] = []
    const { state } = opened({
      engine_sample_commit: (_instance, slot) => {
        declared.push(slot)
        return slot === 0 ? 3 : 0
      },
    })

    unwrapError(loadKit(state, [sample(1, 1), sample(1, 2), sample(1, 3)]))

    expect(declared).toEqual([0])
  })

  it('refuses a message that is not a list of samples', () => {
    // Checked rather than trusted, for the reason `readModule` gives: this
    // crossed a thread boundary, so `LoadKitMessage` describes what the page
    // meant to send. Each of these is a different way the page could be wrong
    // and none of them may reach the ABI.
    const { state } = opened()

    for (const [what, samples] of [
      ['nothing at all', undefined],
      ['not a list', { data: new Float32Array(2), channels: 1 }],
      ['a hole in the list', [sample(1, 1), null]],
      ['data that is not samples', [{ data: [1, 2, 3], channels: 1 }]],
      ['no channel count', [{ data: new Float32Array(2) }]],
      ['zero channels', [{ data: new Float32Array(2), channels: 0 }]],
      ['a fractional channel count', [{ data: new Float32Array(2), channels: 1.5 }]],
      ['a length the channels do not divide', [{ data: new Float32Array(3), channels: 2 }]],
    ] as const) {
      const error = unwrapError(loadKit(state, samples))
      expect(error.kind, `${what} was not refused`).toBe('malformed')
    }
  })

  it('touches nothing when the message is refused', () => {
    // `malformed` is the one failure that leaves the engine exactly as it was.
    // A kit already loaded is still loaded, because nothing was reserved — and
    // a reservation is what would have thrown it away.
    let asked = 0
    const { state } = opened({
      engine_bank_reserve: () => {
        asked += 1
        return FAKE_LAYOUT.arena
      },
    })

    unwrapError(loadKit(state, 'not a kit'))

    expect(asked).toBe(0)
  })

  it('has nothing to load into when the engine never came up', () => {
    expect(unwrapError(loadKit(null, [sample(1, 1)]))).toEqual({ kind: 'no-engine' })
  })

  it('reports an export that is missing rather than throwing out of the handler', () => {
    // The pair this file calls is the one bring-up never does, so a lost
    // `#[unsafe(no_mangle)]` on either survives every check that runs before the
    // first quantum. Unreported, it is a page waiting for an answer that cannot
    // arrive.
    const { state } = opened({
      engine_bank_reserve: undefined as unknown as EngineExports['engine_bank_reserve'],
    })

    const error = unwrapError(loadKit(state, [sample(1, 1)]))

    expect(error.kind).toBe('abi-unusable')
  })
})

describe('answerKitMessage', () => {
  it('answers a loaded kit with what went in', () => {
    const { state } = opened()

    expect(answerKitMessage(state, { type: 'load-kit', samples: [sample(2, 1, 2)] })).toEqual({
      type: 'kit-loaded',
      slots: 1,
      floats: 2,
      // One page, which is what the fake was built with. Asserted against the
      // memory object rather than against 65536, so that the number says
      // "linear memory, as it stands" rather than "the size somebody typed
      // here" — a literal would go on passing if this reported a constant.
      bytes: state.exports.memory.buffer.byteLength,
    })
  })

  it('answers a refusal with the sentence, not the case', () => {
    const { state } = opened({ engine_bank_reserve: () => 0 })

    const answer = answerKitMessage(state, { type: 'load-kit', samples: [sample(1, 1)] })

    expect(answer).toEqual({
      type: 'kit-refused',
      message: describeKitError({ kind: 'refused-arena', floats: 1 }),
    })
  })

  it('says nothing to a message it does not know', () => {
    // Silence, and covered elsewhere rather than ignored: a page speaking a
    // language this bundle does not is what the version word in the ring header
    // refuses before the first quantum.
    const { state } = opened()

    for (const [what, data] of [
      ['nothing', undefined],
      ['null', null],
      ['the tag on its own', 'load-kit'],
      ['another type', { type: 'play' }],
      ['no type at all', {}],
    ] as const) {
      expect(answerKitMessage(state, data), `answered ${what}`).toBeNull()
    }
  })
})

describe('describeKitError', () => {
  it('has a distinct, non-empty message for every failure that exists', () => {
    // Keyed by the union, so a case added to `KitError` fails to compile here
    // until it is given a sample — and `describeKitError` has no default
    // branch, so it fails to compile too.
    const samples: Record<KitError['kind'], KitError> = {
      'no-engine': { kind: 'no-engine' },
      malformed: { kind: 'malformed', received: 'undefined' },
      'abi-unusable': { kind: 'abi-unusable', message: 'not a function' },
      'refused-arena': { kind: 'refused-arena', floats: 12 },
      'refused-sample': {
        kind: 'refused-sample',
        code: 6,
        slot: 2,
        offset: 4,
        frames: 8,
        channels: 1,
        floats: 12,
      },
    }

    const messages = Object.values(samples).map(describeKitError)
    expect(messages.every((message) => message.length > 0)).toBe(true)
    expect(new Set(messages).size).toBe(messages.length)
  })

  it('never continues a sentence after text that came from elsewhere', () => {
    // The rule both other unions keep: a caught throw ends with a full stop as
    // often as not, and ours running on after it put a visible `..` on screen
    // once already.
    const thrown = 'engine.engine_bank_reserve is not a function.'

    expect(describeKitError({ kind: 'abi-unusable', message: thrown }).endsWith(thrown)).toBe(
      true,
    )
  })

  it('says where the number it carries is named', () => {
    // The whole of the decision not to mirror the refusal codes: the page shows
    // a number, so the page has to say where the number means something. A
    // message that dropped this would leave a reader with a digit and nowhere
    // to take it.
    const message = describeKitError({
      kind: 'refused-sample',
      code: 6,
      slot: 2,
      offset: 4,
      frames: 8,
      channels: 1,
      floats: 12,
    })

    expect(message).toContain('crates/engine/src/lib.rs')
  })
})

function ring(): ReturnType<typeof openRing> {
  return openRing(createRing())
}

function opened(overrides: Parameters<typeof fakeEngine>[0] = {}) {
  const engine = fakeEngine(overrides)
  return { engine, state: unwrapValue(openEngine(engine, ring(), SAMPLE_RATE, QUANTUM)) }
}

/** One sample, interleaved the way the page hands it over. */
function sample(channels: number, ...values: number[]): KitSample {
  return { data: Float32Array.from(values), channels }
}

/** The arena as the engine left it, read back out of linear memory. */
function arenaOf(engine: EngineExports, floats: number): Float32Array {
  return new Float32Array(engine.memory.buffer, FAKE_LAYOUT.arena, floats)
}
