// The audio thread's end of the ring. Once per quantum: read the write index,
// copy the command bytes out of the SAB and into WASM linear memory, advance
// the read index, let the engine render, then copy the telemetry block back the
// other way. Both copies live here, because the SharedArrayBuffer and WASM
// linear memory are different buffers and nothing else moves bytes between
// them.
//
// Hot path, so the rules from render.ts apply here too: no allocation, no
// locking, nothing thrown — `subarray` included, for the reason given there.

import { COMMAND_SIZE } from '../audio/protocol'
import {
  TELEMETRY_PEAK_L,
  TELEMETRY_PEAK_R,
  TELEMETRY_STEP,
  TELEMETRY_TRANSPORT_HI,
  TELEMETRY_TRANSPORT_LO,
} from './telemetry-block'
import {
  RING_CAPACITY,
  RING_SLOT_MASK,
  WORD_CMD_READ,
  WORD_CMD_WRITE,
  WORD_PEAK_L,
  WORD_PEAK_R,
  WORD_RENDERED_FRAMES,
  WORD_STEP,
  WORD_TELEMETRY_SEQ,
  WORD_TRANSPORT_HI,
  WORD_TRANSPORT_LO,
} from '../audio/ring'
import type { RingViews } from '../audio/ring'

/**
 * Move whatever the page has queued into the engine's exchange area, and
 * return how many records went. The caller passes that count to
 * `engine_process`.
 *
 * `destination` is the view over `engine_cmd_ptr`, and its length is what
 * `engine_cmd_capacity` reported — so the cap on a quantum's worth of commands
 * is read off the destination rather than tracked beside it. Anything left
 * over waits for the next quantum, under 3 ms away; that is the documented
 * behaviour of the exchange area, not a shortfall.
 */
export function drainCommands(ring: RingViews, destination: Uint8Array): number {
  const { words, records } = ring

  // Acquires every byte the page wrote before it moved this index.
  const write = Atomics.load(words, WORD_CMD_WRITE)
  const read = Atomics.load(words, WORD_CMD_READ)

  // Capped at the ring itself before anything else looks at it. The index came
  // off another thread, which makes it input rather than a promise — the same
  // reason `ring.rs` clamps the record count the worklet claims. A page that
  // ran the write index further ahead than the ring is long would otherwise
  // have this reading slots the writer is overwriting at that moment, and
  // releasing them afterwards as though they had been delivered.
  const queued = (write - read) >>> 0
  const available = queued < RING_CAPACITY ? queued : RING_CAPACITY
  const capacity = (destination.length / COMMAND_SIZE) | 0
  const count = available < capacity ? available : capacity
  if (count === 0) return 0

  // Copied byte by byte, one record at a time. `set` would need a `subarray`
  // to size the source, and a record run can wrap the end of the area anyway —
  // taking the slot per record makes the wrap disappear instead of becoming a
  // second branch. Worst case is 256 records, and the usual case is one.
  for (let index = 0; index < count; index += 1) {
    const from = ((read + index) & RING_SLOT_MASK) * COMMAND_SIZE
    const to = index * COMMAND_SIZE
    for (let byte = 0; byte < COMMAND_SIZE; byte += 1) {
      destination[to + byte] = records[from + byte]
    }
  }

  // Releases the slots back to the page, and not one instruction earlier: the
  // bytes above are still being read until this line.
  Atomics.store(words, WORD_CMD_READ, (read + count) >>> 0)
  return count
}

/**
 * Copy the engine's telemetry block into the ring — the other direction of the
 * exchange above. Called once per quantum, after `engine_process`.
 *
 * The transport position is 64 bits and no single operation can carry it, so
 * the reader would be free to catch the low word of one quantum beside the
 * high word of the next — a jump of a day, at the exact moment the low word
 * wraps. Hence the seqlock: the counter goes odd before the fields move and
 * even after, and a reader that sees an odd value, or two different values
 * around its read, knows to look again.
 *
 * The writer never waits for anything, which is what makes this usable from
 * the audio thread at all. Only the reader retries.
 */
export function publishTelemetry(ring: RingViews, telemetry: Uint32Array): void {
  const { words } = ring

  // The worklet is the only writer, so its own last value is what is there.
  // Keeping the counter here rather than in a field means nothing to reset and
  // nothing that can disagree with the buffer.
  //
  // Rounded up to even before use. It is already even in every ordinary case,
  // this writer having left it so — but a publish cut off half way leaves it
  // odd, and under `panic = "abort"` a killed worklet is exactly that. Carried
  // on from an odd value the parity stays inverted for good, and the page
  // never reads telemetry again: a permanent failure inherited through the
  // buffer from a processor that is already gone.
  const seq = Atomics.load(words, WORD_TELEMETRY_SEQ)
  const start = (seq + (seq & 1)) >>> 0

  Atomics.store(words, WORD_TELEMETRY_SEQ, (start + 1) >>> 0)

  Atomics.store(words, WORD_TRANSPORT_LO, telemetry[TELEMETRY_TRANSPORT_LO])
  Atomics.store(words, WORD_TRANSPORT_HI, telemetry[TELEMETRY_TRANSPORT_HI])
  // Copied as the bits they already are. Reading them as floats here and
  // writing them back would round-trip through a second representation for no
  // reason; the page has a Float32Array over these very bytes.
  Atomics.store(words, WORD_PEAK_L, telemetry[TELEMETRY_PEAK_L])
  Atomics.store(words, WORD_PEAK_R, telemetry[TELEMETRY_PEAK_R])
  // Inside the seqlock with the position rather than beside it: the two are
  // read together and drawn together, and a playhead taken from one quantum
  // over a grid position taken from the next is the tear this counter exists
  // to make impossible.
  Atomics.store(words, WORD_STEP, telemetry[TELEMETRY_STEP])

  Atomics.store(words, WORD_TELEMETRY_SEQ, (start + 2) >>> 0)
}

/**
 * Add a rendered block to the free-running frame counter.
 *
 * Apart from `publishTelemetry` rather than folded into it, and not because it
 * would not fit: that function's whole argument is the seqlock, and a store
 * that deliberately sits outside the seqlock has no business happening inside
 * the lines that open and close it. What the counter is for, and why it is
 * outside, is argued once at `WORD_RENDERED_FRAMES`.
 *
 * Read-modify-write without `Atomics.add`, which would be the obvious reach and
 * buys nothing here: this worklet is the only writer, so there is no other
 * increment to lose, and the load and the store are each already atomic against
 * the reader. `>>> 0` is what keeps the wrap unsigned — the counter is meant to
 * lap, and a value read back as negative would make the reader's difference
 * meaningless in exactly the hour it wrapped.
 */
export function publishRenderedFrames(ring: RingViews, frames: number): void {
  const { words } = ring
  const rendered = Atomics.load(words, WORD_RENDERED_FRAMES)
  Atomics.store(words, WORD_RENDERED_FRAMES, (rendered + frames) >>> 0)
}
