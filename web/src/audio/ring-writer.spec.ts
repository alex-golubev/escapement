// The page's end of the ring. Nothing here needs a browser: `SharedArrayBuffer`
// exists under Node, so this is the real buffer and the real atomics, not a
// stand-in for them.
//
// What the worklet does with the other end is in worklet/exchange.spec.ts,
// where the two are tested together.

import { describe, expect, it } from 'vitest'

import { COMMAND_SIZE, OP_PLAY, OP_STOP } from './protocol'
import { createRing, RING_CAPACITY, WORD_CMD_READ, WORD_CMD_WRITE, openRing } from './ring'
import { createWriter } from './ring-writer'

describe('createWriter', () => {
  it('puts a record in the slot the write index points at, then moves it', () => {
    const { words, records, writer } = ring()

    expect(writer.send({ op: 'play' })).toBe(true)

    expect(records[0]).toBe(OP_PLAY)
    expect(Atomics.load(words, WORD_CMD_WRITE)).toBe(1)
  })

  it('fills consecutive slots and keeps submission order', () => {
    const { records, writer } = ring()

    writer.send({ op: 'play' })
    writer.send({ op: 'stop' })

    expect(records[0]).toBe(OP_PLAY)
    expect(records[COMMAND_SIZE]).toBe(OP_STOP)
  })

  it('comes back round to the first slot after a full lap', () => {
    // The index counts records ever sent and the slot is the low bits of it.
    // Testing the wrap here rather than trusting the mask is the point: a lap
    // takes 1024 gestures, so in a browser this first happens minutes in.
    const { words, records, writer } = ring()

    for (let index = 0; index < RING_CAPACITY; index += 1) {
      writer.send({ op: 'stop' })
      // Read as fast as written, so the ring never fills.
      Atomics.store(words, WORD_CMD_READ, index + 1)
    }
    expect(writer.send({ op: 'play' })).toBe(true)

    expect(records[0]).toBe(OP_PLAY)
    expect(Atomics.load(words, WORD_CMD_WRITE)).toBe(RING_CAPACITY + 1)
  })

  it('drops rather than waits when nothing is draining, and counts what it dropped', () => {
    // Blocking the main thread would freeze the page and blocking the audio
    // thread would be a dropout. Losing the command is the only option left,
    // and the counter is what keeps it from being lost quietly.
    const { writer } = ring()

    for (let index = 0; index < RING_CAPACITY; index += 1) {
      expect(writer.send({ op: 'stop' }), `slot ${index} should still fit`).toBe(true)
    }

    expect(writer.send({ op: 'play' })).toBe(false)
    expect(writer.send({ op: 'play' })).toBe(false)
    expect(writer.dropped()).toBe(2)
  })

  it('does not overwrite a record the reader has not taken yet', () => {
    const { records, writer } = ring()

    writer.send({ op: 'play' })
    for (let index = 1; index < RING_CAPACITY; index += 1) writer.send({ op: 'stop' })
    writer.send({ op: 'stop' }) // refused: the ring is full

    expect(records[0], 'the oldest unread record was overwritten').toBe(OP_PLAY)
  })

  it('accepts again as soon as the reader has made room', () => {
    const { words, writer } = ring()

    for (let index = 0; index < RING_CAPACITY; index += 1) writer.send({ op: 'stop' })
    expect(writer.send({ op: 'play' })).toBe(false)

    Atomics.store(words, WORD_CMD_READ, 1)
    expect(writer.send({ op: 'play' })).toBe(true)
    expect(writer.dropped(), 'the drop already counted must not be recounted').toBe(1)
  })

  it('keeps working across the point where the index no longer fits a signed word', () => {
    // Both indices are u32 and wrap. Their difference is the fill level, which
    // stays right across the wrap only because it is taken as unsigned — and
    // getting that wrong yields a ring that reports itself full forever, some
    // four billion commands in.
    const { words, writer } = ring()
    const nearWrap = 0xffffffff

    Atomics.store(words, WORD_CMD_WRITE, nearWrap)
    Atomics.store(words, WORD_CMD_READ, nearWrap)

    expect(writer.send({ op: 'play' })).toBe(true)
    expect(Atomics.load(words, WORD_CMD_WRITE), 'the index must wrap, not saturate').toBe(0)
    expect(writer.dropped()).toBe(0)
  })
})

function ring() {
  const views = openRing(createRing())
  return { ...views, writer: createWriter(views) }
}
