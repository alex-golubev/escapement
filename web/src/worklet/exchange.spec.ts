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
  WORD_RENDERED_FRAMES,
  WORD_TELEMETRY_SEQ,
  WORD_TRANSPORT_LO,
  createRing,
  openRing,
} from '../audio/ring'
import { createWriter } from '../audio/ring-writer'
import { readRecord, telemetryBlock } from '../../tests/support/abi'
import { CMD_CAPACITY } from '../../tests/support/engine-fake'
import { probe, probeMismatch } from '../../tests/support/ring-harness'
import { drainCommands, publishRenderedFrames, publishTelemetry } from './exchange'

/**
 * Records in the long run below, and the number §6.2 names. It laps the
 * 1024-record ring some ninety-eight times.
 */
const RUN_LENGTH = 100_000

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

  it('takes no more than the ring holds, however far ahead the write index is', () => {
    // The write index is written by the other thread, so it is input and not a
    // promise — `ring.rs` clamps the record count for the same reason. A page
    // that got ahead of itself would otherwise have this copying out slots the
    // writer is filling right now, and then releasing them as delivered.
    const { views } = ring()
    const roomy = new Uint8Array((RING_CAPACITY + 512) * COMMAND_SIZE)

    Atomics.store(views.words, WORD_CMD_WRITE, RING_CAPACITY + 500)

    expect(drainCommands(views, roomy)).toBe(RING_CAPACITY)
    expect(Atomics.load(views.words, WORD_CMD_READ)).toBe(RING_CAPACITY)
  })

  it('carries a hundred thousand records through in order, across the wrap of the index', () => {
    // The run §6.2 asks for, and single-threaded on purpose: what it covers is
    // the arithmetic over distance, not the ordering between two threads, and
    // the two want opposite things from a test. This one is deterministic and
    // reproducible; the ordering is `tests/ring-concurrency.spec.ts`, which is
    // neither by nature.
    //
    // The indices start five hundred short of where a u32 runs out, so the wrap
    // happens early and with a backlog in the ring — slots in use, a reader
    // mid-lap. The wrap is covered next door by substitution on an empty ring,
    // and the point here is the same arithmetic while the ring is working.
    const { writer, views, destination } = ring()
    const block = new DataView(destination.buffer)
    const start = (0xffffffff - 500) >>> 0
    Atomics.store(views.words, WORD_CMD_WRITE, start)
    Atomics.store(views.words, WORD_CMD_READ, start)

    let sent = 0
    let taken = 0
    let attempts = 0
    let refused = 0
    let mismatch: string | null = null

    for (let quantum = 0; taken < RUN_LENGTH; quantum += 1) {
      // A burst that sweeps every size from 1 to 512 against a drain of 256, so
      // the ring spends the run swinging between empty and full instead of
      // settling at one of them. Deterministic — a random burst size would make
      // a failure impossible to reproduce, which §9 rules out for the engine and
      // which is no more welcome here.
      const burst = 1 + ((quantum * 137) % 512)
      for (let n = 0; n < burst && sent < RUN_LENGTH; n += 1) {
        attempts += 1
        // A refusal is the ring full, not a record lost: the drain below makes
        // room and the next burst re-sends this same record.
        if (writer.send(probe(sent))) sent += 1
        else refused += 1
      }

      const count = drainCommands(views, destination)
      for (let slot = 0; slot < count && mismatch === null; slot += 1) {
        mismatch = probeMismatch(block, slot, taken + slot)
      }
      taken += count
    }

    expect(mismatch).toBeNull()
    expect(taken).toBe(RUN_LENGTH)
    expect(sent).toBe(RUN_LENGTH)
    // Every call to `send` did one of two things and never both: put a record
    // in the ring, or add one to the counter.
    expect(attempts).toBe(sent + refused)
    expect(writer.dropped()).toBe(refused)
    // Proof the run went past the point where the index no longer fits a u32,
    // rather than merely being long.
    expect(
      Atomics.load(views.words, WORD_CMD_WRITE),
      'the run has to cross the wrap, or it is only a long run',
    ).toBeLessThan(start)
  })

  it('allocates nothing', () => {
    // Same rule as renderQuantum, and the same trap: `subarray` is the easy
    // way to write this copy, and `set` needs one to size the source.
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

describe('publishTelemetry', () => {
  it('leaves the sequence even, having taken it through odd', () => {
    // The whole protocol in one assertion: a reader that sees an even number
    // unchanged around its read knows the fields between are from one quantum.
    const { views } = ring()

    publishTelemetry(views, telemetryBlock({ position: 1_234 }))

    expect(views.words[WORD_TELEMETRY_SEQ] % 2).toBe(0)
    expect(views.words[WORD_TRANSPORT_LO]).toBe(1_234)
  })

  it('moves the sequence on every quantum, so a stalled writer is visible', () => {
    // Republishing under the same number would make a stopped audio thread
    // indistinguishable from a stopped transport.
    const { views } = ring()
    const seen: number[] = []

    for (let quantum = 0; quantum < 3; quantum += 1) {
      publishTelemetry(views, telemetryBlock({ position: quantum * 128 }))
      seen.push(views.words[WORD_TELEMETRY_SEQ])
    }

    expect(seen).toEqual([2, 4, 6])
  })

  it('keeps the sequence even across the point where a u32 runs out', () => {
    // Parity is what the reader checks, and it survives the wrap only because
    // 2^32 is even. Four billion quanta is a day and a half of playback.
    const { views } = ring()
    Atomics.store(views.words, WORD_TELEMETRY_SEQ, 0xfffffffe)

    publishTelemetry(views, telemetryBlock({ position: 0 }))

    expect(views.words[WORD_TELEMETRY_SEQ]).toBe(0)
  })

  it('recovers a sequence left odd by a writer that died mid-publish', () => {
    // A worklet killed mid-publish leaves the count odd, and a page that then
    // builds a new processor over the same ring inherits it.
    // Carried on as-is the parity stays inverted, and the reader — which has
    // no way to tell that from a write in progress — refuses every frame from
    // then on. Silent, permanent, and nowhere near its cause.
    const { views } = ring()
    Atomics.store(views.words, WORD_TELEMETRY_SEQ, 7)

    publishTelemetry(views, telemetryBlock({ position: 99 }))

    expect(views.words[WORD_TELEMETRY_SEQ] % 2).toBe(0)
    expect(views.words[WORD_TRANSPORT_LO]).toBe(99)
  })

  it('allocates nothing', () => {
    const { views } = ring()
    const words = telemetryBlock()

    const subarray = vi.spyOn(Uint32Array.prototype, 'subarray')
    try {
      publishTelemetry(views, words)
      expect(subarray).not.toHaveBeenCalled()
    } finally {
      subarray.mockRestore()
    }
  })
})

describe('publishRenderedFrames', () => {
  it('accumulates the blocks it is given', () => {
    const { views } = ring()

    for (let quantum = 0; quantum < 4; quantum += 1) publishRenderedFrames(views, 128)

    expect(Atomics.load(views.words, WORD_RENDERED_FRAMES)).toBe(512)
  })

  it('leaves the telemetry sequence alone', () => {
    // The counter sits outside the seqlock, and a store that reached into it
    // would leave the parity inverted — the failure `publishTelemetry` opens
    // even, and this one has no reason to touch at all.
    const { views } = ring()
    publishTelemetry(views, telemetryBlock({ position: 128 }))
    const sequence = Atomics.load(views.words, WORD_TELEMETRY_SEQ)

    publishRenderedFrames(views, 128)

    expect(Atomics.load(views.words, WORD_TELEMETRY_SEQ)).toBe(sequence)
  })

  it('wraps rather than leaving the word negative', () => {
    // Some twenty-five hours in at 48 kHz. Written back signed, the reader's
    // unsigned difference is meaningless from then on — and the only window it
    // is wrong in is the one nobody is watching.
    const { views } = ring()
    Atomics.store(views.words, WORD_RENDERED_FRAMES, 2 ** 32 - 64)

    publishRenderedFrames(views, 128)

    expect(Atomics.load(views.words, WORD_RENDERED_FRAMES)).toBe(64)
  })
})

function ring() {
  const views = openRing(createRing())
  return {
    views,
    writer: createWriter(views),
    // Stands in for the view over `engine_cmd_ptr`, at the size the real
    // engine reports.
    destination: new Uint8Array(CMD_CAPACITY * COMMAND_SIZE),
  }
}

/** The tempo the record in slot `index` carries, whatever else it says. */
function tempoAt(destination: Uint8Array, index: number): number {
  return readRecord(new DataView(destination.buffer), index).value
}
