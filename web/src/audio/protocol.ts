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
 * layout below, and the telemetry block in `worklet/telemetry-block.ts` coming
 * back. Declared that widely there and repeated here because the scope is what
 * makes the number useful — a layout left outside it is one where neither guard
 * fires. Both do: the page stamps this into the ring header and the worklet
 * checks it, catching a bundle that was not rebuilt; and the worklet compares it
 * against `engine_protocol_version()`, catching a wasm that was.
 *
 * Bump on any change to either shape.
 */
export const PROTOCOL_VERSION = 1

/** Mirror of `COMMAND_SIZE` in commands.rs. */
export const COMMAND_SIZE = 16

/** Mirror of `Op` in commands.rs. Numbering starts at 1; 0 means "empty". */
export const OP_PLAY = 1
export const OP_STOP = 2
export const OP_SET_BPM = 3

/**
 * A command as the page states it. This mirrors the `Command` enum rather than
 * the wire record on purpose: no opcode in this milestone carries `arg_a` or
 * `arg_b`, and a caller with nothing to put in them should not be asked for
 * them. Zeroing those fields is the encoder's job, below.
 */
export type Command =
  | { readonly op: 'play' }
  | { readonly op: 'stop' }
  | { readonly op: 'set-bpm'; readonly bpm: number }

/**
 * Write one record at `byteOffset`.
 *
 * All 16 bytes are written, including the fields this opcode does not use. The
 * slot may still hold a record from the previous lap around the ring, and Rust
 * decodes every field it knows about regardless of opcode — a leftover byte
 * read as a live field is precisely the silently-wrong behaviour this contract
 * exists to prevent.
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
  }

  records.setUint8(byteOffset, op)
  records.setUint8(byteOffset + 1, 0)
  records.setUint16(byteOffset + 2, 0, true)
  records.setFloat32(byteOffset + 4, value, true)
  records.setUint32(byteOffset + 8, atSample >>> 0, true)
  records.setUint32(byteOffset + 12, Math.floor(atSample / 2 ** 32), true)
}
