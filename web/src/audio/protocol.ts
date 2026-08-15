// The TypeScript half of the two-file contract with commands.rs, edited
// together with it. Here in `audio/` rather than in the worklet because both
// threads need it: the page encodes records through `writeCommand`, the worklet
// reads `COMMAND_SIZE` to copy and to size its exchange area.
//
// This file mirrors the record format and nothing else. Two other contracts sit
// beside it, divided by which memory each describes: the layout of the ring the
// records travel in is `ring.ts` — the SharedArrayBuffer, and no Rust half at
// all, since the engine never sees the ring — and the block coming back the
// other way is `worklet/telemetry-block.ts`, which describes WASM linear memory
// and is therefore addressed by the audio thread alone.
//
// Record layout, 16 bytes, little-endian, mirroring the block at the top of
// commands.rs:
//
//   offset 0   u8   op       — opcode; 0 means "empty"
//   offset 1   u8   arg_a    — track / slot
//   offset 2   u16  arg_b    — step / parameter index
//   offset 4   f32  value    — value
//   offset 8   u32  at_lo    — target sample, low word
//   offset 12  u32  at_hi    — target sample, high word
//
// Little-endian is WASM's own byte order; `DataView` requires saying so, which
// is the trailing `true` on every call below.

/**
 * Mirror of `PROTOCOL_VERSION` in commands.rs.
 *
 * Its scope is everything that crosses the ABI in either direction: the record
 * layout below, the telemetry block in `worklet/telemetry-block.ts` coming back,
 * and the grid the record's address fields index — `TRACKS` by `STEPS`, just
 * below. Declared that widely there and repeated here because the scope is what
 * makes the number useful — anything left outside it is where neither guard
 * fires. Both do: the page stamps this into the ring header and the worklet
 * checks it, catching a bundle that was not rebuilt; and the worklet compares it
 * against `engine_protocol_version()`, catching a wasm that was.
 *
 * The second of those is the only thing that can catch a grid which differs
 * between the languages. A pin agrees with its own side by construction, so
 * both pins stay green through a one-sided change; what they buy is that
 * bumping this number stops being optional.
 *
 * Bump on any change to any of the three.
 */
export const PROTOCOL_VERSION = 3

/** Mirror of `COMMAND_SIZE` in commands.rs. */
export const COMMAND_SIZE = 16

/**
 * The grid a record addresses into: `TRACKS` mirrors the constant of that name
 * in lib.rs, `STEPS` the one in pattern.rs.
 *
 * Here rather than left to whoever draws the grid, because these two are a
 * contract and not a layout choice, and the failure they carry is unlike the
 * other two this file mirrors. A record with a wrong byte layout produces wrong
 * values; a worklet built against an older shape produces silence. A grid
 * larger on this side than in the engine produces neither: the engine drops an
 * index past the end of its own grid, which is the right guard, so the extra
 * tracks accept every command and do nothing at all, and no counter anywhere
 * moves. Changing either number is an ABI change — mirror it in the other
 * language and bump `PROTOCOL_VERSION` above.
 *
 * Ranges are a different matter and are not mirrored here. A gain outside its
 * limits is clamped and still sounds, so keeping the UI inside it is the UI's
 * own business; an index outside the grid is not clamped into a neighbour, it
 * is dropped. Only the second kind has to agree across the wire.
 */
export const TRACKS = 8
export const STEPS = 16

/**
 * Mirror of `Op` in commands.rs. Numbering starts at 1; 0 means "empty".
 *
 * Exported one by one rather than as a set, and only the three that are read
 * from outside: they are how a test names the byte it expects to find in a
 * slot. An export with no caller is a contract offered to nobody, and the five
 * below had one reader between them — a test asserting that they existed.
 * Their numbers are pinned all the same, and by something stronger: the table
 * in the spec encodes every command through `writeCommand` and holds the byte
 * that comes out against a literal, so a constant that changed would fail
 * there whether or not anything outside this file can see it.
 */
export const OP_PLAY = 1
export const OP_STOP = 2
export const OP_SET_STEP = 7

const OP_SET_BPM = 3
const OP_SET_TRACK_GAIN = 4
const OP_SET_TRACK_PAN = 5
const OP_SET_MASTER_GAIN = 6
const OP_CLEAR_PATTERN = 8

/**
 * A command as the page states it. This mirrors the `Command` enum rather than
 * the wire record on purpose: a caller states a track and a gain, not an
 * `arg_a` and a `value`, and the ones with nothing to address are not asked
 * for an address at all. Which field of the record each lands in — and zeroing
 * the fields an opcode does not use — is the encoder's job, below.
 *
 * Ranges are not stated here either. The engine clamps whatever arrives,
 * because a value that crossed a thread boundary is input rather than a
 * promise; that clamp is a guard and not a channel, so it corrects in silence.
 * Keeping the UI inside the range is the UI's own business.
 */
export type Command =
  | { readonly op: 'play' }
  | { readonly op: 'stop' }
  | { readonly op: 'set-bpm'; readonly bpm: number }
  | { readonly op: 'set-track-gain'; readonly track: number; readonly gain: number }
  | { readonly op: 'set-track-pan'; readonly track: number; readonly pan: number }
  | { readonly op: 'set-master-gain'; readonly gain: number }
  /** Velocity `0` switches the step off; there is no separate flag on the wire. */
  | {
      readonly op: 'set-step'
      readonly track: number
      readonly step: number
      readonly velocity: number
    }
  | { readonly op: 'clear-pattern' }

/**
 * Write one record at `byteOffset`.
 *
 * All 16 bytes are written, including the fields this opcode does not use. The
 * slot may still hold a record from the previous lap around the ring, and Rust
 * decodes every field it knows about regardless of opcode — a leftover byte
 * read as a live field is precisely the silently-wrong behaviour this contract
 * exists to prevent.
 *
 * A track number occupies the single byte `arg_a` and a step the two bytes of
 * `arg_b`, so anything outside 0–255 and 0–65535 wraps rather than failing
 * here. `TRACKS` and `STEPS` keep that unreachable from a working UI by a wide
 * margin, and the engine drops an index past the end of the grid in any case —
 * but the wrap happens on this side, before the engine has anything to drop,
 * which is why the spec asserts the grid still fits these two fields.
 *
 * `atSample` is `0` for "immediately". It stays a plain number: exact to 2^53,
 * which is 22 000 years at 48 kHz, so `BigInt` buys nothing. `>>> 0` is a
 * modulo 2^32 for any non-negative integer, which is the low word by
 * definition.
 */
export function writeCommand(
  records: DataView,
  byteOffset: number,
  command: Command,
  atSample: number,
): void {
  // Declared without a value so that a command variant with no branch below is
  // a compile error here, not a record with opcode `undefined` on the wire.
  let op: number
  let argA = 0
  let argB = 0
  let value = 0

  switch (command.op) {
    case 'play':
      op = OP_PLAY
      break
    case 'stop':
      op = OP_STOP
      break
    case 'set-bpm':
      op = OP_SET_BPM
      value = command.bpm
      break
    case 'set-track-gain':
      op = OP_SET_TRACK_GAIN
      argA = command.track
      value = command.gain
      break
    case 'set-track-pan':
      op = OP_SET_TRACK_PAN
      argA = command.track
      value = command.pan
      break
    case 'set-master-gain':
      op = OP_SET_MASTER_GAIN
      value = command.gain
      break
    case 'set-step':
      op = OP_SET_STEP
      argA = command.track
      argB = command.step
      value = command.velocity
      break
    case 'clear-pattern':
      op = OP_CLEAR_PATTERN
      break
  }

  records.setUint8(byteOffset, op)
  records.setUint8(byteOffset + 1, argA)
  records.setUint16(byteOffset + 2, argB, true)
  records.setFloat32(byteOffset + 4, value, true)
  records.setUint32(byteOffset + 8, atSample >>> 0, true)
  records.setUint32(byteOffset + 12, Math.floor(atSample / 2 ** 32), true)
}
