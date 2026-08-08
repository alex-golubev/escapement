// The page's end of the command ring: the only place a command is written.
//
// One writer and one reader per direction, which is what lets this work with
// plain loads and stores and no compare-and-swap. The ordering that makes it
// correct is the pair at the end of `send`: the record bytes are written
// first, and only then does the index move. The worklet reads the index with
// `Atomics.load` before it touches any byte, so a record it can see is a
// record that was finished.

import { COMMAND_SIZE, writeCommand } from './protocol'
import type { Command } from './protocol'
import {
  RING_CAPACITY,
  RING_SLOT_MASK,
  WORD_CMD_DROPPED,
  WORD_CMD_READ,
  WORD_CMD_WRITE,
} from './ring'
import type { RingViews } from './ring'

export interface RingWriter {
  /**
   * Hand one command to the audio thread, applied at the top of the next
   * quantum. `false` means the ring was full and the command was dropped —
   * see `dropped()`.
   */
  send(command: Command): boolean
  /**
   * How many commands have been thrown away for want of room. Non-zero is a
   * bug, not a load condition: 1024 records is some three seconds of gestures,
   * and nothing here sends in bulk yet.
   *
   * Nothing calls this outside its own spec, and that is the honest state of it
   * rather than an oversight. What the counter exists for is that drops must
   * never pile up unseen — and today they cannot, because `send` returns
   * `false` in the same breath as the increment, and the page turns the first
   * one into a failure on screen. The counter says nothing the caller was not
   * just told.
   *
   * It stops being redundant with the first caller that sends in bulk — opening
   * a project pushes hundreds of parameters through here — and at that point
   * the useful question is how many were lost, not whether one was.
   */
  dropped(): number
}

export function createWriter(ring: RingViews): RingWriter {
  // Taken from the opened ring rather than built here: where the header ends
  // and the records begin is stated in ring.ts and nowhere else.
  const { words, recordFields } = ring

  return {
    send(command: Command): boolean {
      const write = Atomics.load(words, WORD_CMD_WRITE)
      const read = Atomics.load(words, WORD_CMD_READ)

      // Both indices count records ever passed, and wrap with u32. Their
      // difference is the fill level, and `>>> 0` is what makes that true
      // across the wrap as well as before it.
      if ((write - read) >>> 0 >= RING_CAPACITY) {
        // Dropped rather than awaited. Blocking the main thread is a frozen
        // page and blocking the audio thread is a dropout, so the only
        // remaining option is to lose the command and say so.
        Atomics.add(words, WORD_CMD_DROPPED, 1)
        return false
      }

      // Immediate: `at_sample = 0`. Nothing schedules ahead yet, and until
      // something does, the engine applying commands in submission order
      // cannot be told apart from applying them in time order.
      writeCommand(recordFields, (write & RING_SLOT_MASK) * COMMAND_SIZE, command, 0)

      // Publishes every byte written above. Must stay last.
      Atomics.store(words, WORD_CMD_WRITE, (write + 1) >>> 0)
      return true
    },

    dropped(): number {
      return Atomics.load(words, WORD_CMD_DROPPED)
    },
  }
}
