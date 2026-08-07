// The audio thread's end of the ring: steps 1-3 of the per-quantum exchange in
// §3.5 of the plan. The SharedArrayBuffer and WASM linear memory are different
// buffers, and this is the copy between them.
//
// Hot path, so the rules from render.ts apply here too: no allocation, no
// locking, nothing thrown. In particular no `subarray` — it builds a view
// object per call, and this runs 375 times a second.

import { COMMAND_SIZE } from '../audio/protocol'
import { RING_SLOT_MASK, WORD_CMD_READ, WORD_CMD_WRITE } from '../audio/ring'
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

  const available = (write - read) >>> 0
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
