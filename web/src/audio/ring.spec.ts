// The layout itself, which until `openRing` became the only place it is
// realized had no test of its own — it was covered a piece at a time, by
// whichever suite happened to need that piece.
//
// What is pinned here is not the numbers. It is that the four views agree:
// they are cut from one buffer, two of them share an index space, and two of
// them address the same records. Every file downstream takes those three
// properties for granted, and none of them states one.

import { describe, expect, it } from 'vitest'

import { COMMAND_SIZE, PROTOCOL_VERSION } from './protocol'
import {
  COMMANDS_BYTE_OFFSET,
  RING_BYTES,
  RING_CAPACITY,
  WORD_PEAK_L,
  WORD_PROTOCOL_VERSION,
  createRing,
  headerWords,
  openRing,
} from './ring'

describe('openRing', () => {
  it('cuts every view from the buffer it was handed', () => {
    const buffer = createRing()
    const views = openRing(buffer)

    for (const view of [views.words, views.peaks, views.records, views.recordFields]) {
      expect(view.buffer).toBe(buffer)
    }
  })

  it('puts the header before the records and lets neither reach the other', () => {
    // The command area is a view of its own so that a slot offset is not also
    // a base offset — `records[0]` is the first record, not the version word.
    const { words, records } = openRing(createRing())

    expect(words.byteOffset).toBe(0)
    expect(words.byteLength).toBe(COMMANDS_BYTE_OFFSET)
    expect(records.byteOffset).toBe(COMMANDS_BYTE_OFFSET)
    expect(records.byteLength).toBe(RING_CAPACITY * COMMAND_SIZE)
    expect(COMMANDS_BYTE_OFFSET + records.byteLength).toBe(RING_BYTES)
  })

  it('addresses the peaks by the same index in either view', () => {
    // One index into two views, which holds only while both count in units of
    // four bytes. Get it wrong and the meters read a neighbouring field, and
    // read it silently: any word at all comes back as some number.
    const { words, peaks } = openRing(createRing())

    words[WORD_PEAK_L] = new Uint32Array(new Float32Array([0.25]).buffer)[0]
    expect(peaks[WORD_PEAK_L]).toBe(0.25)
  })

  it('shows the same record bytes through both views over them', () => {
    // The page writes fields in a stated byte order, the worklet copies bytes.
    // Two views, one area: a record written through one is the record the
    // other copies out.
    const { records, recordFields } = openRing(createRing())

    recordFields.setUint8(COMMAND_SIZE, 0xab)
    expect(records[COMMAND_SIZE]).toBe(0xab)
    expect(recordFields.byteOffset).toBe(records.byteOffset)
    expect(recordFields.byteLength).toBe(records.byteLength)
  })
})

describe('createRing', () => {
  it('stamps the version in the word the worklet reads it from', () => {
    // Both ends go through `headerWords` now. Stamped through a view of its
    // own, this agreed only for as long as the version stayed the first word:
    // move it, and the page writes one place while the worklet reads another,
    // and every start fails against a number nobody wrote.
    expect(headerWords(createRing())[WORD_PROTOCOL_VERSION]).toBe(PROTOCOL_VERSION)
  })

  it('is long enough for the header and every record', () => {
    expect(createRing().byteLength).toBe(RING_BYTES)
  })
})
