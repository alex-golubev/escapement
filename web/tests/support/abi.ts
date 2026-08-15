// The two shapes that cross the ABI, from the side that has to read them back:
// one record out of a block of them, and the telemetry block as the engine
// leaves it.
//
// Here rather than beside the encoders in `src/` because nothing that ships
// decodes a record or builds a block. The page writes records and the engine
// reads them; the engine writes the block and the page reads it through
// `telemetry.ts`, which reports three numbers and never the words. A decoder
// next to `writeCommand` would be code sent to every visitor with no caller.
//
// The pins do not use this file, and must not. `protocol.spec.ts` and
// `commands::tests::wire_format_is_pinned` compare an encoded record against
// literal bytes, because a record checked against a decoder written from the
// same paragraph agrees with it through any pair of matching moves — the layout
// could shift by four bytes in both and nothing would go red. What is served
// here is the other kind of test, where reading a record is the means and which
// record it is, is the question.
//
// Nothing here imports from `node:`, for the reason given in ring-harness.ts.

import { COMMAND_SIZE } from '../../src/audio/protocol'
import {
  TELEMETRY_PEAK_L,
  TELEMETRY_PEAK_R,
  TELEMETRY_TRANSPORT_HI,
  TELEMETRY_TRANSPORT_LO,
  TELEMETRY_WORDS,
} from '../../src/worklet/telemetry-block'

/** One record, under the wire's own field names rather than any command's. */
export interface WireRecord {
  readonly op: number
  readonly argA: number
  readonly argB: number
  readonly value: number
  /** The two `at` words put back together the way the engine puts them. */
  readonly at: number
}

/** Read record `index` out of a block of them. */
export function readRecord(records: DataView, index: number): WireRecord {
  const offset = index * COMMAND_SIZE
  return {
    op: records.getUint8(offset),
    argA: records.getUint8(offset + 1),
    argB: records.getUint16(offset + 2, true),
    value: records.getFloat32(offset + 4, true),
    at: records.getUint32(offset + 12, true) * 2 ** 32 + records.getUint32(offset + 8, true),
  }
}

/**
 * What a caller wants to find in the block. Anything left out is zero, which is
 * what a block that was never written holds anyway.
 */
export interface TelemetryFields {
  readonly position?: number
  readonly peakL?: number
  readonly peakR?: number
}

/** A block of readings, as the engine would have left it in linear memory. */
export function telemetryBlock(fields: TelemetryFields = {}): Uint32Array {
  const words = new Uint32Array(TELEMETRY_WORDS)
  writeTelemetryBlock(words, fields)
  return words
}

/**
 * The same, into a block that already exists — which is what the concurrency
 * worker publishes from, thousands of times over a run. It holds one block for
 * the whole of it, so that the thread whose job is to crowd the ring is not also
 * making garbage.
 */
export function writeTelemetryBlock(words: Uint32Array, fields: TelemetryFields): void {
  const { position = 0, peakL = 0, peakR = 0 } = fields
  words[TELEMETRY_TRANSPORT_LO] = position >>> 0
  words[TELEMETRY_TRANSPORT_HI] = Math.floor(position / 2 ** 32)
  words[TELEMETRY_PEAK_L] = bitsOf(peakL)
  words[TELEMETRY_PEAK_R] = bitsOf(peakR)
}

// One float and the same four bytes read as an integer — `f32::to_bits` on
// this side. A `Float32Array` over the caller's own block would do it just as
// well and build a view per call; this pair is made once.
const asFloat = new Float32Array(1)
const asBits = new Uint32Array(asFloat.buffer)

function bitsOf(value: number): number {
  asFloat[0] = value
  return asBits[0]
}
