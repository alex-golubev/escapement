// The mirror of `engine::tests::telemetry_layout_is_pinned`, and the same
// assertion written twice on purpose — one list of expected indices in each
// language, exactly as protocol.spec.ts and `commands::tests::wire_format_is_pinned`
// do it for the record format.
//
// Why a change detector earns its place here: every other test that touches
// these constants reads them, so it agrees with whatever they happen to say.
// Swapping two of them was tried against the Rust suite and all sixty-nine
// tests passed. What a renumbering has to hit is a literal, and the failure is
// the signal to reconcile engine.rs with this file and bump PROTOCOL_VERSION.
//
// Whether the compiled engine actually writes what is claimed here is a
// different question, answered in tests/engine-abi.spec.ts against the real
// artifact — which is the only place it can be answered.

import { describe, expect, it } from 'vitest'

import {
  TELEMETRY_PEAK_L,
  TELEMETRY_PEAK_R,
  TELEMETRY_TRANSPORT_HI,
  TELEMETRY_TRANSPORT_LO,
  TELEMETRY_WORDS,
} from './telemetry-block'

describe('the telemetry block', () => {
  it('numbers its words the way engine.rs numbers them', () => {
    expect(TELEMETRY_WORDS).toBe(4)
    expect([
      TELEMETRY_TRANSPORT_LO,
      TELEMETRY_TRANSPORT_HI,
      TELEMETRY_PEAK_L,
      TELEMETRY_PEAK_R,
    ]).toEqual([0, 1, 2, 3])
  })

  it('gives every field a word of its own, inside the block', () => {
    // Stated separately from the pin above because it is the property the pin
    // protects rather than the numbers themselves: two fields sharing an index
    // would have one silently overwrite the other, and an index past the end
    // would read whatever the engine keeps after the block. Both survive a
    // renumbering that keeps the count.
    const indices = [
      TELEMETRY_TRANSPORT_LO,
      TELEMETRY_TRANSPORT_HI,
      TELEMETRY_PEAK_L,
      TELEMETRY_PEAK_R,
    ]

    expect(new Set(indices).size, 'two fields share a word').toBe(indices.length)
    expect(indices.every((index) => index >= 0 && index < TELEMETRY_WORDS)).toBe(true)
    expect(indices.length, 'a field was added without room for it').toBe(TELEMETRY_WORDS)
  })
})
