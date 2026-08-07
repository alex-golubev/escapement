// The layout of the SharedArrayBuffer both threads look at, and the only file
// that states it. Imported by the page and by the worklet bundle alike.
//
// This is a contract between two JavaScript programs, not with Rust: the
// engine never sees the ring (§3.5 of the plan). It gets a copy of the command
// bytes in its own linear memory, and hands telemetry back the same way. What
// crosses to Rust is the record format, which lives in protocol.ts.
//
// Word indices, into a Uint32Array laid over the whole buffer:
//
//   0   protocol_version   written once by the page
//   1   cmd_write          Atomics; written by the page
//   2   cmd_read           Atomics; written by the worklet
//   3   cmd_dropped        Atomics; written by the page
//   16  telemetry_seq      odd while a write is in progress
//   17  underrun_count     reserved; nothing writes it yet
//   18  transport_lo
//   19  transport_hi
//   20  peak_l             f32 bits, as `f32::to_bits` left them
//   21  peak_r             f32 bits
//   32  commands           RING_CAPACITY records of COMMAND_SIZE bytes
//
// The two directions start 64 bytes apart so that writers going opposite ways
// do not contend on one cache line. Everything is 4-aligned, which is what
// lets a single Uint32Array address the header, the telemetry and the atomics
// alike, and a Float32Array over the same bytes read the peaks as numbers.

import { COMMAND_SIZE, PROTOCOL_VERSION } from './protocol'

/**
 * Records in the ring. Must stay a power of two: the slot of a record is
 * `index & RING_SLOT_MASK`, and the unsigned difference of two monotonic
 * indices is only meaningful across the u32 wrap because 2^32 divides evenly
 * by this.
 */
export const RING_CAPACITY = 1024

export const RING_SLOT_MASK = RING_CAPACITY - 1

export const WORD_PROTOCOL_VERSION = 0
export const WORD_CMD_WRITE = 1
export const WORD_CMD_READ = 2
export const WORD_CMD_DROPPED = 3

export const WORD_TELEMETRY_SEQ = 16
export const WORD_UNDERRUN_COUNT = 17
export const WORD_TRANSPORT_LO = 18
export const WORD_TRANSPORT_HI = 19
export const WORD_PEAK_L = 20
export const WORD_PEAK_R = 21

/** Base of the command area. A multiple of 16, so every record is aligned. */
export const COMMANDS_BYTE_OFFSET = 128

export const RING_BYTES = COMMANDS_BYTE_OFFSET + RING_CAPACITY * COMMAND_SIZE

/**
 * The views both sides build over the buffer. Neither can detach: a
 * SharedArrayBuffer does not grow, which is the whole difference between these
 * and the views over WASM linear memory.
 */
export interface RingViews {
  /** Header, telemetry and both atomic index words. */
  readonly words: Uint32Array
  /** The command area alone, so a slot offset is not also a base offset. */
  readonly records: Uint8Array
}

export function openRing(ring: SharedArrayBuffer): RingViews {
  return {
    words: new Uint32Array(ring, 0, COMMANDS_BYTE_OFFSET / Uint32Array.BYTES_PER_ELEMENT),
    records: new Uint8Array(ring, COMMANDS_BYTE_OFFSET, RING_CAPACITY * COMMAND_SIZE),
  }
}

/**
 * Allocate the ring. Throws where `SharedArrayBuffer` is unavailable — which
 * is any page without cross-origin isolation, so the caller has to answer for
 * it rather than assume.
 *
 * The version word is stamped here and checked by the worklet. Comparing it
 * against `protocol.ts` proves nothing about Rust, both being the same side of
 * that contract — but the page and the worklet are two separately built
 * artifacts, and this catches the one that was not rebuilt.
 */
export function createRing(): SharedArrayBuffer {
  const ring = new SharedArrayBuffer(RING_BYTES)
  new Uint32Array(ring, 0, 1)[0] = PROTOCOL_VERSION
  return ring
}
