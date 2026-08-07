// The render path, which until it moved out of the processor class no test
// could reach.
//
// Two of the tests below are about allocation rather than output. They look
// fussy and are not: a dropout appears nowhere near the line that caused it.

import { describe, expect, it, vi } from 'vitest'

import { WORD_CMD_READ, createRing, openRing } from '../audio/ring'
import { createWriter } from '../audio/ring-writer'
import { openEngine } from './engine'
import type { EngineState } from './engine'
import { refreshViews, renderQuantum } from './render'
import { FAKE_LAYOUT, fakeEngine } from '../../tests/support/engine-fake'
import { unwrapValue } from '../../tests/support/unwrap'

const QUANTUM = FAKE_LAYOUT.quantum
const SAMPLE_RATE = 44100

describe('renderQuantum', () => {
  it('copies what the engine rendered into both channels of the output', () => {
    const { state } = openedEngine()
    fillViews(state)

    const output = [emptyBlock(QUANTUM), emptyBlock(QUANTUM)]
    renderQuantum(state, [output])

    expect(Array.from(output[0])).toEqual(Array.from(state.views.outL))
    expect(Array.from(output[1])).toEqual(Array.from(state.views.outR))
    // The channels must not be the same data: a copy that fills both from outL
    // is a stereo image collapsed to mono, which is easy to miss by ear.
    expect(output[0][1]).not.toBe(output[1][1])
  })

  it('returns the number of frames it rendered', () => {
    const { state } = openedEngine()
    expect(renderQuantum(state, [[emptyBlock(QUANTUM), emptyBlock(QUANTUM)]])).toBe(QUANTUM)
  })

  it('leaves the engine alone when the host handed over nothing to fill', () => {
    // Web Audio may call `process` with no connected output. Calling
    // `engine_process` anyway would advance the transport against silence
    // nobody asked for, and the drift would never be recovered.
    let calls = 0
    const { state, writer } = openedEngine({ engine_process: () => void (calls += 1) })
    writer.send({ op: 'play' })

    expect(renderQuantum(state, [])).toBe(0)
    expect(renderQuantum(state, [[]])).toBe(0)
    expect(calls).toBe(0)
    // And the command is still in the ring. Drained here it would have been
    // copied into an exchange area that no `engine_process` will read, which
    // is a command accepted from the page and then thrown away.
    expect(Atomics.load(state.ring.words, WORD_CMD_READ)).toBe(0)
  })

  it('hands the engine however many commands the page had queued', () => {
    // The count is the whole contract with `engine_process`: the exchange area
    // holds bytes either way, and this number is what says how many of them
    // are records from this quantum.
    const counts: number[] = []
    const { state, writer } = openedEngine({
      engine_process: (_instance, _frames, cmdCount) => counts.push(cmdCount),
    })

    renderQuantum(state, [[emptyBlock(QUANTUM)]])

    writer.send({ op: 'play' })
    writer.send({ op: 'set-bpm', bpm: 90 })
    renderQuantum(state, [[emptyBlock(QUANTUM)]])

    renderQuantum(state, [[emptyBlock(QUANTUM)]])

    expect(counts).toEqual([0, 2, 0])
  })

  it('fills the one channel it was given when the output is mono', () => {
    const { state } = openedEngine()
    fillViews(state)

    const output = [emptyBlock(QUANTUM)]
    expect(renderQuantum(state, [output])).toBe(QUANTUM)
    expect(Array.from(output[0])).toEqual(Array.from(state.views.outL))
  })

  it('allocates nothing on the block size Web Audio actually uses', () => {
    // `subarray` builds a new view object on every call. At 48 kHz that is 375
    // of them a second, thrown away immediately, on the one thread that must
    // not collect garbage. The block is always 128 frames and the engine was
    // allocated for exactly that, so the trimming call has to be skipped
    // rather than merely made cheap.
    const { state } = openedEngine()
    const subarray = vi.spyOn(Float32Array.prototype, 'subarray')
    try {
      renderQuantum(state, [[emptyBlock(QUANTUM), emptyBlock(QUANTUM)]])
      expect(subarray).not.toHaveBeenCalled()
    } finally {
      subarray.mockRestore()
    }
  })

  it('still comes out right on a block shorter than the engine allocated for', () => {
    // "Always 128" is a property of the host, not of this code. The trimming
    // branch is what keeps that assumption from being load-bearing.
    const { state } = openedEngine()
    fillViews(state)

    const short = QUANTUM / 2
    const output = [emptyBlock(short), emptyBlock(short)]
    expect(renderQuantum(state, [output])).toBe(short)
    expect(Array.from(output[0])).toEqual(Array.from(state.views.outL.subarray(0, short)))
  })
})

describe('refreshViews', () => {
  it('hands back the very same state while the views are still attached', () => {
    // The path taken every quantum. Returning a fresh object here would be an
    // allocation per block, which is the thing this file exists to prevent.
    const { state } = openedEngine()
    expect(refreshViews(state)).toBe(state)
  })

  it('rebuilds after memory.grow has detached every view', () => {
    // Not a simulated detach: `memory.grow` performs the real one, and a view
    // over a detached buffer reads as empty rather than failing.
    const { engine, state } = openedEngine()

    engine.memory.grow(1)
    expect(state.views.outL).toHaveLength(0)

    const refreshed = refreshViews(state)
    // Compared as a boolean rather than with `not.toBe`: on failure the
    // matcher would diff the two states, and walking a detached view throws
    // before the real assertion ever gets to report anything.
    expect(Object.is(refreshed, state)).toBe(false)
    expect(refreshed.views.buffer).toBe(engine.memory.buffer)
    expect(refreshed.views.outL).toHaveLength(QUANTUM)
    // Everything else is carried over untouched — a rebuild replaces views,
    // not the handle the engine was opened with.
    expect(refreshed.instance).toBe(state.instance)
    expect(refreshed.protocolVersion).toBe(state.protocolVersion)
  })
})

function openedEngine(overrides: Parameters<typeof fakeEngine>[0] = {}) {
  const engine = fakeEngine(overrides)
  const buffer = createRing()
  return {
    engine,
    writer: createWriter(buffer),
    state: unwrapValue(openEngine(engine, openRing(buffer), SAMPLE_RATE, QUANTUM)),
  }
}

/** Distinct, non-zero data per channel, so a mixed-up copy cannot pass. */
function fillViews(state: EngineState): void {
  for (let i = 0; i < QUANTUM; i += 1) {
    state.views.outL[i] = (i + 1) / QUANTUM
    state.views.outR[i] = -(i + 1) / QUANTUM
  }
}

function emptyBlock(frames: number): Float32Array {
  return new Float32Array(frames)
}
