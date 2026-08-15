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

import { COMMAND_SIZE, OP_PLAY, OP_STOP, STEPS, TRACKS, writeCommand } from './protocol'
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
  'set-step': [{ op: 'set-step', track: 3, step: 513, velocity: 0.6 }, 7],
  'clear-pattern': [{ op: 'clear-pattern' }, 8],
  'set-metronome': [{ op: 'set-metronome', enabled: true }, 9],
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

  it('addresses a track and a step where commands.rs pins them', () => {
    // The second byte-for-byte pin, mirroring the one commands.rs grew for the
    // same reason: until the mixer and the pattern, every command wrote zeros
    // into arg_a and arg_b, so their offsets were held by a comment and by
    // nothing else. The two fields are adjacent, which is where a one-byte
    // slip stays plausible — a step written one byte early lands on the track
    // number, and every strike in the grid goes to the same track.
    //
    // The step is 513, which the grid does not have, so that both bytes of
    // arg_b hold something. It is the only 16-bit field in the record, and a
    // step from inside the sixteen leaves the high byte zero — an array that
    // would be just as true of a field eight bits wide. Narrowing it here was
    // tried and passed every test in this file.
    expect(
      Array.from(encode({ op: 'set-step', track: 3, step: 513, velocity: 0.5 }, 0)),
    ).toEqual([
      0x07, // op = SetStep
      0x03, // arg_a = track 3
      0x01,
      0x02, // arg_b = step 513, little-endian
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

  it('mirrors the grid the address fields index', () => {
    // The third thing PROTOCOL_VERSION covers, after the record layout and the
    // telemetry block, and the one that moves no byte when it changes: arg_a is
    // one byte at eight tracks and at twelve. What changes is which addresses
    // mean anything on the far side. An index past the end of the grid is
    // dropped by the engine — the right guard — so a page built for twelve
    // tracks against an engine holding eight gets four tracks that take every
    // command and do nothing, with no counter anywhere to show it.
    //
    // Literals, like every pin here. This one cannot catch a divergence from
    // Rust on its own — it agrees with its own side by construction, as the
    // Rust pin agrees with its own. Only the version check does that, and this
    // is what makes bumping the version non-optional: a failure here is an ABI
    // change, so mirror commands.rs and lib.rs and raise the number.
    expect([TRACKS, STEPS]).toEqual([8, 16])
  })

  it('keeps the grid inside the fields that address it', () => {
    // The only statement on this side tying "a field this wide" to "a grid this
    // big", mirroring the one in commands.rs. Neither wrap is loud: setUint8 is
    // a modulo, so a track of 300 would go out as 44 and arrive as a legal
    // address for the wrong track. Growing the grid past a field is a change to
    // the record, not to the grid alone.
    expect(TRACKS, 'arg_a is one byte').toBeLessThanOrEqual(2 ** 8)
    expect(STEPS, 'arg_b is two bytes').toBeLessThanOrEqual(2 ** 16)
  })

  it('carries a step in the two bytes the engine reads back', () => {
    // What the pin above rests on, said out loud so that it does not rest on
    // one specimen. A step of 513 up there is exactly the kind of thing a
    // later reader replaces with one the grid has, out of tidiness, and the
    // high byte of arg_b stops being written the moment they do. The boundary
    // is 255/256, where a field narrowed to a byte stops agreeing with one
    // that was not.
    //
    // Rust holds the same range in `round_trips_the_full_range_of_a_step`, and
    // from the other end: there a step survives the round trip, here it
    // reaches the bytes at all. Neither side can check the other's half.
    for (const step of [0, 1, 15, 255, 256, 257, 65535]) {
      const bytes = encode({ op: 'set-step', track: 3, step, velocity: 0.5 }, 0)
      const argB = new DataView(bytes.buffer).getUint16(2, true)
      expect(argB, `step ${step} did not survive the write`).toBe(step)
    }
  })

  it('carries the metronome switch on the side of zero the engine reads it by', () => {
    // The engine takes this field as "non-zero is on", so what has to be right
    // is which side of zero the number lands on rather than the number itself.
    // Both states are written out because `false` shares its encoding with a
    // field nobody filled: a switch that forgot to write `value` at all would
    // still say "off", and only the `true` case can tell the two apart.
    const flag = (enabled: boolean): number =>
      new DataView(encode({ op: 'set-metronome', enabled }, 0).buffer).getFloat32(4, true)

    expect(flag(true)).toBe(1)
    expect(flag(false)).toBe(0)
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
