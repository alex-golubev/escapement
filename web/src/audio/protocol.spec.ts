// The byte layout, from this side.
//
// Rust pins the same layout in `commands::tests::wire_format_is_pinned`, and
// the two tests are deliberately the same assertion written twice: one array
// of expected bytes in each language, for one record. A layout change fails
// both, which is the signal CLAUDE.md describes — reconcile commands.rs with
// protocol.ts and bump the version.
//
// Whether the compiled engine actually reads what is written here is a
// different question, and no test in this file can answer it. That one is in
// tests/engine-abi.spec.ts.

import { describe, expect, it } from 'vitest'

import {
  COMMAND_SIZE,
  OP_PLAY,
  OP_SET_BPM,
  OP_SET_MASTER_GAIN,
  OP_SET_TRACK_GAIN,
  OP_SET_TRACK_PAN,
  OP_STOP,
  writeCommand,
} from './protocol'
import type { Command } from './protocol'

/** 0x0000_00AB_1234_5678 — the same instant the Rust test encodes. */
const PINNED_AT_SAMPLE = 0xab * 2 ** 32 + 0x12345678

/**
 * Every command, with the opcode byte commands.rs numbers it with.
 *
 * Keyed by the union, the way the error unions are pinned elsewhere: a command
 * added to `Command` fails to compile here until it is given an entry, and
 * `writeCommand` has no default branch, so it fails to compile too.
 *
 * The numbers are literals rather than the `OP_*` constants. An encoded record
 * compared against the very constant that encoded it is one expression checked
 * against itself and stays green through any renumbering — the same reason the
 * Rust table opposite this one is written out in literals. Two tables in two
 * languages holding the same numbers is what makes this a contract; one table
 * read twice would be a copy.
 */
const OPCODES: Record<Command['op'], readonly [command: Command, opcode: number]> = {
  play: [{ op: 'play' }, 1],
  stop: [{ op: 'stop' }, 2],
  'set-bpm': [{ op: 'set-bpm', bpm: 120 }, 3],
  'set-track-gain': [{ op: 'set-track-gain', track: 5, gain: 0.75 }, 4],
  'set-track-pan': [{ op: 'set-track-pan', track: 2, pan: -0.5 }, 5],
  'set-master-gain': [{ op: 'set-master-gain', gain: 1.25 }, 6],
}

describe('writeCommand', () => {
  it('lays out a record byte for byte the way commands.rs pins it', () => {
    expect(Array.from(encode({ op: 'set-bpm', bpm: 1 }, PINNED_AT_SAMPLE))).toEqual([
      0x03, // op = SetBpm
      0x00, // arg_a
      0x00,
      0x00, // arg_b
      0x00,
      0x00,
      0x80,
      0x3f, // value = 1.0f32, little-endian
      0x78,
      0x56,
      0x34,
      0x12, // at_lo
      0xab,
      0x00,
      0x00,
      0x00, // at_hi
    ])
  })

  it('gives each command the opcode number commands.rs decodes it by', () => {
    for (const [command, opcode] of Object.values(OPCODES)) {
      expect(encode(command, 0)[0], `${command.op} went out under another opcode`).toBe(opcode)
    }
  })

  it('exports an opcode constant for each of those numbers', () => {
    // Separate from the table above, and not a restatement of it: these
    // constants are how ring-writer.spec.ts names the record it expects to find
    // in a slot, so they are read outside this file, and nothing else says what
    // they are worth.
    expect([
      OP_PLAY,
      OP_STOP,
      OP_SET_BPM,
      OP_SET_TRACK_GAIN,
      OP_SET_TRACK_PAN,
      OP_SET_MASTER_GAIN,
    ]).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('addresses a track through arg_a, the way commands.rs pins it', () => {
    // The second half of the byte-for-byte pin, and the reason commands.rs
    // grew one too: until the mixer, every command wrote a zero into arg_a,
    // so the field's offset was held by a comment and by nothing else. A track
    // written one byte over would land in arg_b, decode as zero, and put every
    // track's gain on track 0.
    expect(Array.from(encode({ op: 'set-track-gain', track: 5, gain: 0.5 }, 0))).toEqual([
      0x04, // op = SetTrackGain
      0x05, // arg_a = track 5
      0x00,
      0x00, // arg_b
      0x00,
      0x00,
      0x00,
      0x3f, // value = 0.5f32, little-endian
      0x00,
      0x00,
      0x00,
      0x00, // at_lo — immediate
      0x00,
      0x00,
      0x00,
      0x00, // at_hi
    ])
  })

  it('carries the tempo as the f32 the engine reads back', () => {
    const bytes = encode({ op: 'set-bpm', bpm: 174.5 }, 0)
    expect(new DataView(bytes.buffer).getFloat32(4, true)).toBe(174.5)
  })

  it('overwrites every byte of a slot that still holds an older record', () => {
    // What a slot looks like on the second lap around the ring. Rust decodes
    // `value` regardless of opcode, so a leftover byte in a field this command
    // does not use is not inert — it is a wrong number the engine believes.
    const dirty = new Uint8Array(COMMAND_SIZE).fill(0xee)
    writeCommand(new DataView(dirty.buffer), 0, { op: 'stop' }, 0)

    expect(Array.from(dirty)).toEqual([OP_STOP, ...new Array<number>(COMMAND_SIZE - 1).fill(0)])
  })

  it('splits an instant into the two words the engine reassembles', () => {
    // Positions around 2^32, where getting the split wrong stays invisible for
    // the first day of any session and then jumps the playhead by 24 hours.
    for (const at of [0, 1, 2 ** 32 - 1, 2 ** 32, 2 ** 32 + 12345, 2 ** 53 - 1]) {
      const view = new DataView(encode({ op: 'play' }, at).buffer)
      const lo = view.getUint32(8, true)
      const hi = view.getUint32(12, true)
      expect(hi * 2 ** 32 + lo, `at_sample ${at} did not survive the split`).toBe(at)
    }
  })

  it('writes at the offset it was given and nowhere else', () => {
    // Records sit at slot boundaries in a shared area; a write that ignored
    // the offset would corrupt the neighbour rather than fail.
    const area = new Uint8Array(COMMAND_SIZE * 3)
    writeCommand(new DataView(area.buffer), COMMAND_SIZE, { op: 'play' }, 0)

    expect(area[COMMAND_SIZE]).toBe(OP_PLAY)
    expect(area.slice(0, COMMAND_SIZE).some((byte) => byte !== 0)).toBe(false)
    expect(area.slice(COMMAND_SIZE * 2).some((byte) => byte !== 0)).toBe(false)
  })
})

function encode(command: Command, atSample: number): Uint8Array {
  const bytes = new Uint8Array(COMMAND_SIZE)
  writeCommand(new DataView(bytes.buffer), 0, command, atSample)
  return bytes
}
