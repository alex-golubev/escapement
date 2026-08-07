// The audio thread's end of the ring, tested against the page's real writer
// rather than against bytes laid out by hand. The two agreeing is the property
// worth having; each being self-consistent is not.
//
// `SharedArrayBuffer` and `Atomics` both exist under Node, so nothing here is
// simulated. What cannot be reached from here is the two ends running at once,
// on different threads — the ordering that makes that safe is argued in the
// source and observed in a browser.

import { describe, expect, it, vi } from 'vitest'

import { COMMAND_SIZE } from '../audio/protocol'
import {
  RING_CAPACITY,
  WORD_CMD_READ,
  WORD_CMD_WRITE,
  createRing,
  openRing,
} from '../audio/ring'
import { createWriter } from '../audio/ring-writer'
import { drainCommands } from './exchange'

/** What the engine reports through `engine_cmd_capacity`. */
const CMD_CAPACITY = 256

describe('drainCommands', () => {
  it('moves what the page queued, in submission order', () => {
    const { writer, views, destination } = ring()

    writer.send({ op: 'set-bpm', bpm: 90 })
    writer.send({ op: 'set-bpm', bpm: 174 })

    expect(drainCommands(views, destination)).toBe(2)
    expect(tempoAt(destination, 0)).toBe(90)
    expect(tempoAt(destination, 1)).toBe(174)
  })

  it('takes nothing, and moves nothing, when the page has sent nothing', () => {
    const { views, destination } = ring()

    expect(drainCommands(views, destination)).toBe(0)
    expect(Atomics.load(views.words, WORD_CMD_READ)).toBe(0)
  })

  it('releases exactly the slots it took', () => {
    // The read index is what gives the page room again. Advancing it by more
    // than was copied hands back slots holding records nobody has looked at.
    const { writer, views, destination } = ring()

    writer.send({ op: 'play' })
    writer.send({ op: 'stop' })
    drainCommands(views, destination)

    expect(Atomics.load(views.words, WORD_CMD_READ)).toBe(2)
  })

  it('takes only what the exchange area holds and leaves the rest queued', () => {
    // Overflow is not an error here: the remainder waits one quantum, which is
    // under 3 ms. Dropping it instead would lose commands that were accepted.
    const { writer, views, destination } = ring()

    for (let index = 0; index < CMD_CAPACITY + 10; index += 1) {
      writer.send({ op: 'set-bpm', bpm: 100 + index })
    }

    expect(drainCommands(views, destination)).toBe(CMD_CAPACITY)
    expect(tempoAt(destination, 0)).toBe(100)
    expect(tempoAt(destination, CMD_CAPACITY - 1)).toBe(100 + CMD_CAPACITY - 1)

    expect(drainCommands(views, destination)).toBe(10)
    expect(tempoAt(destination, 0)).toBe(100 + CMD_CAPACITY)
  })

  it('empties a full ring over consecutive quanta, losing nothing', () => {
    const { writer, views, destination } = ring()

    for (let index = 0; index < RING_CAPACITY; index += 1) {
      writer.send({ op: 'set-bpm', bpm: 20 + index })
    }

    let taken = 0
    for (let quantum = 0; quantum < RING_CAPACITY / CMD_CAPACITY; quantum += 1) {
      const count = drainCommands(views, destination)
      expect(count).toBe(CMD_CAPACITY)
      expect(tempoAt(destination, 0)).toBe(20 + taken)
      taken += count
    }

    expect(taken).toBe(RING_CAPACITY)
    expect(drainCommands(views, destination)).toBe(0)
  })

  it('reads a run that wraps the end of the area as one run', () => {
    // A record run is copied slot by slot precisely so that the wrap is not a
    // second code path. This is the test that would catch it becoming one.
    const { writer, views, destination } = ring()

    const start = RING_CAPACITY - 2
    Atomics.store(views.words, WORD_CMD_WRITE, start)
    Atomics.store(views.words, WORD_CMD_READ, start)

    for (let index = 0; index < 4; index += 1) writer.send({ op: 'set-bpm', bpm: 60 + index })

    expect(drainCommands(views, destination)).toBe(4)
    for (let index = 0; index < 4; index += 1) {
      expect(tempoAt(destination, index), `record ${index} came back wrong`).toBe(60 + index)
    }
  })

  it('allocates nothing', () => {
    // Same rule as renderQuantum, and the same reason: this runs 375 times a
    // second on the thread that must not collect garbage. `subarray` is the
    // easy way to write this copy and it builds a view object per call.
    const { writer, views, destination } = ring()
    writer.send({ op: 'play' })

    const subarray = vi.spyOn(Uint8Array.prototype, 'subarray')
    try {
      expect(drainCommands(views, destination)).toBe(1)
      expect(subarray).not.toHaveBeenCalled()
    } finally {
      subarray.mockRestore()
    }
  })

  it('takes its limit from the exchange area it was handed', () => {
    // The cap is read off the destination rather than kept alongside it: that
    // view is built from `engine_cmd_capacity`, so the number the drain obeys
    // and the number the engine allocated for are one number, not two that
    // agree today.
    const { writer, views } = ring()
    const small = new Uint8Array(4 * COMMAND_SIZE)

    for (let index = 0; index < 10; index += 1) writer.send({ op: 'stop' })

    expect(drainCommands(views, small)).toBe(4)
    expect(Atomics.load(views.words, WORD_CMD_READ)).toBe(4)
  })
})

function ring() {
  const buffer = createRing()
  return {
    views: openRing(buffer),
    writer: createWriter(buffer),
    // Stands in for the view over `engine_cmd_ptr`, at the size the real
    // engine reports.
    destination: new Uint8Array(CMD_CAPACITY * COMMAND_SIZE),
  }
}

function tempoAt(destination: Uint8Array, index: number): number {
  return new DataView(destination.buffer).getFloat32(index * COMMAND_SIZE + 4, true)
}
