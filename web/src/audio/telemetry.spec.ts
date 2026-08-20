// Reading the audio thread's telemetry, and the seqlock that makes the reading
// trustworthy.
//
// The values are written here by the worklet's own `publishTelemetry` rather
// than by hand: the interesting property is that the two halves agree, and a
// test that lays out the ring itself would only prove that this file agrees
// with itself. What cannot be reached from here is the two threads racing —
// the torn read below is produced by substitution, and deliberately so: the
// alternative is a test that waits for a coincidence.

import { describe, expect, it, vi } from 'vitest'

import { WORD_TELEMETRY_SEQ, createRing, openRing } from './ring'
import { createReader, renderDrift } from './telemetry'
import { publishRenderedFrames, publishTelemetry } from '../worklet/exchange'
// The block as the engine leaves it in linear memory, standing in for Rust.
import { telemetryBlock } from '../../tests/support/abi'

describe('createReader', () => {
  it('reads back what the worklet published', () => {
    const { views, reader } = setup()
    publishTelemetry(
      views,
      telemetryBlock({ position: 48_000, peakL: 0.5, peakR: 0.25, step: 6.5 }),
    )

    expect(reader.read()).toEqual({ position: 48_000, peakL: 0.5, peakR: 0.25, step: 6.5 })
    expect(
      Atomics.load(views.words, WORD_TELEMETRY_SEQ) % 2,
      'the sequence must be left even for the next reader',
    ).toBe(0)
  })

  it('carries a position that no single word could hold', () => {
    // The reason this is a seqlock and not a plain read. Below 2^32 a torn
    // pair is still a wrong number; at the boundary it is a jump of 24 hours,
    // which is how the bug announces itself a day into a session.
    const { views, reader } = setup()

    for (const position of [0, 1, 2 ** 32 - 1, 2 ** 32, 2 ** 32 + 12_345, 2 ** 40 + 7]) {
      publishTelemetry(views, telemetryBlock({ position }))
      expect(reader.read()?.position, `position ${position} did not survive`).toBe(position)
    }
  })

  it('reads the peaks as the floats Rust turned into bits', () => {
    // `Math.fround` on the expectation, not a tolerance: the trip through the
    // block narrows a double to an f32 and nothing else touches it, so every
    // one of these comes back exactly or the reading is not a reinterpretation
    // at all.
    const { views, reader } = setup()

    for (const peak of [0, 1, 0.25, 1e-20, 0.1]) {
      publishTelemetry(views, telemetryBlock({ peakL: peak, peakR: peak }))
      expect(reader.read()?.peakL, `peak ${peak} did not survive`).toBe(Math.fround(peak))
    }
  })

  it('refuses to read while a write is in progress', () => {
    // An odd sequence means the fields are a mix of two quanta right now.
    // Returning them would be worse than returning nothing: the caller has a
    // previous frame to fall back on, and no way to spot a bad reading.
    const { views, reader } = setup()
    publishTelemetry(views, telemetryBlock({ position: 1_000 }))
    Atomics.store(views.words, WORD_TELEMETRY_SEQ, 3)

    expect(reader.read()).toBeNull()
  })

  it('refuses a reading the writer overtook while it was being taken', () => {
    // The other half of the seqlock: the sequence was even on the way in and
    // has moved by the way out, so a whole publish landed between the two
    // words that were just read. Substituted, because on one thread this
    // cannot otherwise happen.
    const { views, reader } = setup()
    publishTelemetry(views, telemetryBlock({ position: 1_000 }))

    // `Atomics.load` is overloaded, and `vi.spyOn` resolves to the BigInt64
    // signature — while the reader only ever calls it on a Uint32Array.
    // Narrowed to the two methods used here rather than widened to `any`.
    const load = vi.spyOn(Atomics, 'load') as unknown as {
      mockReturnValueOnce(value: number): void
      mockRestore(): void
    }
    try {
      // Two loads per attempt: the one that opens it and the one that checks.
      for (let attempt = 0; attempt < 8; attempt += 1) {
        load.mockReturnValueOnce(attempt % 2 === 0 ? 2 : 4)
      }
      expect(reader.read()).toBeNull()
    } finally {
      load.mockRestore()
    }
  })

  it('is good again on the next frame once the writer has finished', () => {
    // A refusal is not a state to recover from — the next read simply works.
    const { views, reader } = setup()

    Atomics.store(views.words, WORD_TELEMETRY_SEQ, 1)
    expect(reader.read()).toBeNull()

    publishTelemetry(views, telemetryBlock({ position: 256 }))
    expect(reader.read()?.position).toBe(256)
  })
})

describe('rendered', () => {
  it('reads back what the worklet counted', () => {
    const { views, reader } = setup()

    expect(reader.rendered(), 'a fresh ring has rendered nothing').toBe(0)
    publishRenderedFrames(views, 128)
    publishRenderedFrames(views, 128)

    expect(reader.rendered()).toBe(256)
  })

  it('is not refused while a telemetry write is in progress', () => {
    // The counter is outside the seqlock, and this is what that buys: a reader
    // arriving mid-publish still gets it. Were it inside, the one reading that
    // has to keep working when the page is busy would be the one that retries.
    const { views, reader } = setup()
    publishRenderedFrames(views, 512)
    Atomics.store(views.words, WORD_TELEMETRY_SEQ, 3)

    expect(reader.read(), 'the snapshot is refused, as it should be').toBeNull()
    expect(reader.rendered()).toBe(512)
  })
})

describe('renderDrift', () => {
  const RATE = 48_000

  it('is zero when the thread rendered exactly the time that passed', () => {
    expect(renderDrift({ frames: 0, at: 0 }, { frames: RATE, at: 1_000 }, RATE)).toBe(0)
  })

  it('reports how far behind the thread fell, per second of clock', () => {
    // A second of wall clock against 47 000 frames: the thread produced
    // 979.17 ms of audio, so it lost 20.83 ms. Positive is behind, which is the
    // only direction that means anything.
    const drift = renderDrift({ frames: 0, at: 0 }, { frames: 47_000, at: 1_000 }, RATE)

    expect(drift).toBeCloseTo(20.833, 3)
  })

  it('is a rate, so the same loss across a wider window is a smaller number', () => {
    // The window is the caller's, and this is what it buys. One reading of the
    // counter is out by up to one of the device's chunks, and that error is a
    // fixed quantity of milliseconds however long the window was — so the rate
    // it is divided into is the only figure two windows can be compared by, or
    // held against one threshold. Both of these lost half a second.
    const short = renderDrift({ frames: 0, at: 0 }, { frames: RATE / 2, at: 1_000 }, RATE)
    const wide = renderDrift({ frames: 0, at: 0 }, { frames: RATE * 7.5, at: 8_000 }, RATE)

    expect(short).toBeCloseTo(500, 6)
    expect(wide, 'the total was published where a rate was meant').toBeCloseTo(62.5, 6)
  })

  it('survives the counter lapping', () => {
    // The whole reason the subtraction is unsigned. A plain difference here
    // answers minus four billion frames — the render thread reported as having
    // run a day ahead, once, some twenty-five hours into a session, and only
    // then. Nothing but an explicit case finds that.
    const before = { frames: 2 ** 32 - 1_000, at: 0 }
    const after = { frames: 2_000, at: (3_000 / RATE) * 1_000 }

    expect(renderDrift(before, after, RATE), 'the lap was read as time lost').toBe(0)
  })

  it('answers nothing for a window with no time in it', () => {
    // Two readings in the same millisecond describe nothing, and a zero here
    // would be indistinguishable from a healthy measurement. The caller keeps
    // what it had, exactly as it does for a refused telemetry read.
    expect(renderDrift({ frames: 0, at: 5 }, { frames: 0, at: 5 }, RATE)).toBeNull()
    expect(renderDrift({ frames: 0, at: 5 }, { frames: 0, at: 4 }, RATE)).toBeNull()
  })

  it('answers nothing for a rate that cannot divide', () => {
    // The rate is the engine's reading of the device, not a constant here, so a
    // zero is a value this function can be handed rather than one it can rule
    // out. Dividing by it would answer with an infinity that draws as a drift.
    expect(renderDrift({ frames: 0, at: 0 }, { frames: 128, at: 1_000 }, 0)).toBeNull()
  })
})

function setup() {
  const views = openRing(createRing())
  return { views, reader: createReader(views) }
}
