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
import { createReader } from './telemetry'
import { publishTelemetry } from '../worklet/exchange'
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

function setup() {
  const views = openRing(createRing())
  return { views, reader: createReader(views) }
}
