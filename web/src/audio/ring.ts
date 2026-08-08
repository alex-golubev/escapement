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
 *
 * All four are built at once even though no single caller uses all four — the
 * page writes records and reads peaks, the worklet reads records and writes
 * position. A view is one object built once, and the alternative is each end
 * restating where the area it wants begins, which is how this file stops being
 * the only place the layout is written down.
 */
export interface RingViews {
  /** Header, telemetry and both atomic index words. */
  readonly words: Uint32Array
  /**
   * The same bytes as `words`, read as the floats the peaks are. One index
   * space serves both because a `u32` and an `f32` are four bytes alike, which
   * is why `WORD_PEAK_L` addresses this view as well.
   */
  readonly peaks: Float32Array
  /** The command area alone, so a slot offset is not also a base offset. */
  readonly records: Uint8Array
  /**
   * The same records as fields in a stated byte order — what the page writes
   * a command through. Built here, once, rather than per command: that path is
   * the one a fader drag takes, and a `DataView` per gesture is an allocation
   * on it.
   */
  readonly recordFields: DataView
}

/**
 * The header alone, as words.
 *
 * Apart from `openRing` because the version has to be read before anything is
 * built over the buffer at all — a ring stamped by a page this bundle does not
 * agree with is one nothing should be built over.
 */
export function headerWords(ring: SharedArrayBuffer): Uint32Array {
  return new Uint32Array(ring, 0, COMMANDS_BYTE_OFFSET / Uint32Array.BYTES_PER_ELEMENT)
}

export function openRing(ring: SharedArrayBuffer): RingViews {
  const recordBytes = RING_CAPACITY * COMMAND_SIZE
  return {
    words: headerWords(ring),
    peaks: new Float32Array(ring, 0, COMMANDS_BYTE_OFFSET / Float32Array.BYTES_PER_ELEMENT),
    records: new Uint8Array(ring, COMMANDS_BYTE_OFFSET, recordBytes),
    recordFields: new DataView(ring, COMMANDS_BYTE_OFFSET, recordBytes),
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
  // Through `Atomics`, like every other word that crosses to the other thread.
  // A plain store would in fact be safe here — this runs before the buffer is
  // posted, and `postMessage` orders everything written before it — but being
  // the one exception is worth more than the instruction it saves: the rule
  // "cross-thread words go through Atomics" is easier to keep when it has no
  // exceptions to remember.
  Atomics.store(headerWords(ring), WORD_PROTOCOL_VERSION, PROTOCOL_VERSION)
  return ring
}
