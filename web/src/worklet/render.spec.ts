// The render path, which until it moved out of the processor class no test
// could reach.
//
// Two of the tests below are about allocation rather than output. They look
// fussy and are not: a dropout appears nowhere near the line that caused it.

import { describe, expect, it, vi } from 'vitest'

import {
  WORD_CMD_READ,
  WORD_RENDERED_FRAMES,
  WORD_TELEMETRY_SEQ,
  WORD_TRANSPORT_LO,
  createRing,
  openRing,
} from '../audio/ring'
import { createWriter } from '../audio/ring-writer'
import { openEngine } from './engine'
import type { EngineState } from './engine'
import { refreshViews, renderQuantum } from './render'
import { TELEMETRY_TRANSPORT_LO } from './telemetry-block'
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

  it('returns the size of the block it was handed', () => {
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

  it('publishes what the engine left in its telemetry block', () => {
    // `engine_process` fills that block on the way out. Getting it into the
    // ring is this function's last act, and the page has no other source.
    const { state } = openedEngine()
    state.views.telemetry[TELEMETRY_TRANSPORT_LO] = 4242

    renderQuantum(state, [[emptyBlock(QUANTUM)]])

    expect(state.ring.words[WORD_TRANSPORT_LO]).toBe(4242)
    expect(state.ring.words[WORD_TELEMETRY_SEQ]).toBe(2)
  })

  it('publishes nothing for a block it never rendered', () => {
    // Otherwise the same quantum is republished under a fresh sequence number,
    // and a reader watching a stalled engine sees a healthy one holding still.
    const { state } = openedEngine()

    expect(renderQuantum(state, [])).toBe(0)
    expect(state.ring.words[WORD_TELEMETRY_SEQ]).toBe(0)
    expect(
      state.ring.words[WORD_RENDERED_FRAMES],
      'a block that was never rendered was counted as time the thread spent',
    ).toBe(0)
  })

  it('counts the frames it rendered, quantum after quantum', () => {
    // What the drift measurement is taken from. It has to advance on every
    // block and only on rendered ones: counted short, a healthy thread reads as
    // falling behind, and the reading is worth nothing in the direction that
    // would send somebody looking for a dropout that never happened.
    const { state } = openedEngine()

    for (let quantum = 0; quantum < 3; quantum += 1) {
      renderQuantum(state, [[emptyBlock(QUANTUM), emptyBlock(QUANTUM)]])
    }

    expect(state.ring.words[WORD_RENDERED_FRAMES]).toBe(QUANTUM * 3)
  })

  it('counts the block the host handed over, not the part the engine filled', () => {
    // The two differ only past `maxFrames`, where the engine renders a prefix
    // and the rest is zeroed. The device still consumed the whole block, and it
    // is the device the count is held against — so counting the rendered part
    // would report silence as lost time.
    const { state } = openedEngine()
    const oversized = state.maxFrames + 64

    renderQuantum(state, [[emptyBlock(oversized)]])

    expect(state.ring.words[WORD_RENDERED_FRAMES]).toBe(oversized)
  })

  it('allocates nothing on the block size Web Audio actually uses', () => {
    // The branch `copyChannel` is shaped around, held to by a test because
    // nothing else would notice it going: the two trimming branches are
    // correct, so a block routed through one of them renders identically and
    // allocates on every quantum.
    const { state } = openedEngine()
    const subarray = vi.spyOn(Float32Array.prototype, 'subarray')
    try {
      renderQuantum(state, [[emptyBlock(QUANTUM), emptyBlock(QUANTUM)]])
      expect(subarray).not.toHaveBeenCalled()
    } finally {
      subarray.mockRestore()
    }
  })

  it('asks the engine for no more than it was allocated for', () => {
    // The opposite direction from the test below, and the one that used to be
    // silent: the engine clamps `frames` to `max_frames` on its own side, so a
    // larger block was rendered half way while the number crossing the ABI
    // claimed otherwise. Passing the clamped count is what keeps the two sides
    // saying the same thing.
    const asked: number[] = []
    const { state } = openedEngine({
      engine_process: (_instance, frames) => void asked.push(frames),
    })

    const long = QUANTUM * 2
    expect(
      renderQuantum(state, [[emptyBlock(long)]]),
      'the block size is what is reported',
    ).toBe(long)
    expect(asked).toEqual([QUANTUM])
  })

  it('leaves no stale tail on a block longer than the engine allocated for', () => {
    // The frames past what was rendered belong to a buffer the host may well
    // reuse. Left alone they are the previous block played a second time —
    // audible, and pointing nowhere near this line.
    const { state } = openedEngine()
    fillViews(state)

    const long = QUANTUM * 2
    const left = emptyBlock(long)
    left.fill(0.7, QUANTUM)
    renderQuantum(state, [[left]])

    expect(Array.from(left.subarray(0, QUANTUM))).toEqual(Array.from(state.views.outL))
    expect(Array.from(left.subarray(QUANTUM)).filter((sample) => sample !== 0)).toEqual([])
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
  const views = openRing(createRing())
  return {
    engine,
    writer: createWriter(views),
    state: unwrapValue(openEngine(engine, views, SAMPLE_RATE, QUANTUM)),
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
