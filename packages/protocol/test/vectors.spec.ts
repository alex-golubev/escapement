// SPDX-License-Identifier: Apache-2.0
//
// The TypeScript side of the golden vectors, reading the same hand-written
// file as the Rust side (ADR-0011).

import { readFileSync } from "node:fs"
import { describe, expect, test } from "vitest"
import * as protocol from "../src/index.js"

type Vector = {
  record?: string
  command?: string
  frame_offset?: string
  fields: Record<string, string>
  bytes: string
}

const vectors = JSON.parse(
  readFileSync(new URL("../../../schema/vectors/boundary.json", import.meta.url), "utf8"),
) as {
  enums: { enum: string; codes: Record<string, number> }[]
  arrays: { record: string; field: string; offset: number; length: number }[]
  records: Vector[]
  commands: Vector[]
}

const codesOf = (name: string) => {
  const found = vectors.enums.find((candidate) => candidate.enum === name)
  if (!found) throw new Error(`no vector for ${name}`)
  return found.codes
}

const arrayOf = (field: string) => {
  const found = vectors.arrays.find((candidate) => candidate.field === field)
  if (!found) throw new Error(`no vector for ${field}`)
  return found
}

const hex = (text: string) => Number.parseInt(text, 16)

const bytes = (text: string) => {
  const digits = text.replace(/\s+/g, "")
  const out = new Uint8Array(digits.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(digits.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

const find = (group: Vector[], key: "record" | "command", name: string) => {
  const vector = group.find((candidate) => candidate[key] === name)
  if (!vector) throw new Error(`no vector for ${name}`)
  return vector
}

const buffer = (size: number) => {
  const bytes = new ArrayBuffer(size)
  return { bytes, view: new DataView(bytes), atoms: new Int32Array(bytes) }
}

/** A slot as the ring hands it back: still holding the command written into it
 *  last time round. A command vector's zero bytes are a promise that a writer
 *  fills the whole payload, so the tests have to start from something else. */
const reusedSlot = () => {
  const slot = buffer(protocol.COMMAND_SLOT_SIZE)
  new Uint8Array(slot.bytes).fill(0xaa)
  return slot
}

describe("records", () => {
  test("command_slot matches its vector", () => {
    const vector = find(vectors.records, "record", "command_slot")
    const slot = buffer(protocol.COMMAND_SLOT_SIZE)

    protocol.writeCommandSlotKind(slot.view, 0, hex(vector.fields.kind as string))
    protocol.writeCommandSlotFrameOffset(slot.view, 0, hex(vector.fields.frame_offset as string))

    expect(new Uint8Array(slot.bytes)).toEqual(bytes(vector.bytes))
    expect(protocol.readCommandSlotKind(slot.view, 0)).toBe(hex(vector.fields.kind as string))
    expect(protocol.readCommandSlotFrameOffset(slot.view, 0)).toBe(
      hex(vector.fields.frame_offset as string),
    )
  })

  /** The engine's own half of the meters: plain memory the glue reads, not the
   *  shared copy it publishes. */
  test("engine_report matches its vector", () => {
    const vector = find(vectors.records, "record", "engine_report")
    const report = buffer(protocol.ENGINE_REPORT_SIZE)
    const signed = (name: string) => hex(vector.fields[name] as string) | 0

    protocol.writeEngineReportPositionFrames(report.view, 0, signed("position_frames"))
    protocol.writeEngineReportPeakAmpMicro(report.view, 0, signed("peak_amp_micro"))
    protocol.writeEngineReportTransportState(report.view, 0, signed("transport_state"))
    protocol.writeEngineReportDroppedCommands(
      report.view,
      0,
      hex(vector.fields.dropped_commands as string),
    )

    expect(new Uint8Array(report.bytes)).toEqual(bytes(vector.bytes))
    expect(protocol.readEngineReport(report.view, 0)).toEqual({
      positionFrames: signed("position_frames"),
      // An amplitude times a million, so this one is 1.0.
      peakAmpMicro: 1_000_000,
      transportState: signed("transport_state"),
      droppedCommands: 2,
    })
  })

  test("command_slot reads back as a snapshot", () => {
    const vector = find(vectors.records, "record", "command_slot")
    const slot = buffer(protocol.COMMAND_SLOT_SIZE)

    protocol.writeCommandSlotKind(slot.view, 0, hex(vector.fields.kind as string))
    protocol.writeCommandSlotFrameOffset(slot.view, 0, hex(vector.fields.frame_offset as string))

    expect(protocol.readCommandSlot(slot.view, 0)).toEqual({
      kind: hex(vector.fields.kind as string),
      frameOffset: hex(vector.fields.frame_offset as string),
    })
  })

  test("meter_block matches its vector", () => {
    const vector = find(vectors.records, "record", "meter_block")
    const block = buffer(protocol.METER_BLOCK_SIZE)
    // The fields are i32, so a vector value above 0x7fffffff is negative.
    const signed = (name: string) => hex(vector.fields[name] as string) | 0

    protocol.storeMeterBlockBlockCounter(block.atoms, 0, signed("block_counter"))
    protocol.storeMeterBlockPositionFrames(block.atoms, 0, signed("position_frames"))
    protocol.storeMeterBlockPeakAmpMicro(block.atoms, 0, signed("peak_amp_micro"))
    protocol.storeMeterBlockTransportState(block.atoms, 0, signed("transport_state"))

    expect(new Uint8Array(block.bytes)).toEqual(bytes(vector.bytes))
    expect(protocol.loadMeterBlockPeakAmpMicro(block.atoms, 0)).toBe(-1)
  })

  test("meter_block reads back as a snapshot", () => {
    const vector = find(vectors.records, "record", "meter_block")
    const block = buffer(protocol.METER_BLOCK_SIZE)
    const signed = (name: string) => hex(vector.fields[name] as string) | 0

    protocol.storeMeterBlockBlockCounter(block.atoms, 0, signed("block_counter"))
    protocol.storeMeterBlockPositionFrames(block.atoms, 0, signed("position_frames"))
    protocol.storeMeterBlockPeakAmpMicro(block.atoms, 0, signed("peak_amp_micro"))
    protocol.storeMeterBlockTransportState(block.atoms, 0, signed("transport_state"))

    expect(protocol.readMeterBlock(block.atoms, 0)).toEqual({
      blockCounter: signed("block_counter"),
      positionFrames: signed("position_frames"),
      peakAmpMicro: -1,
      transportState: signed("transport_state"),
    })
  })
})

describe("commands", () => {
  test("play matches its vector", () => {
    const vector = find(vectors.commands, "command", "play")
    const slot = reusedSlot()

    protocol.writePlay(
      slot.view,
      0,
      hex(vector.frame_offset as string),
      hex(vector.fields.from_frame as string),
    )

    expect(new Uint8Array(slot.bytes)).toEqual(bytes(vector.bytes))
    expect(protocol.readPlay(slot.view, 0)).toEqual({
      fromFrame: hex(vector.fields.from_frame as string),
    })
  })

  test("stop matches its vector", () => {
    const vector = find(vectors.commands, "command", "stop")
    const slot = reusedSlot()

    protocol.writeStop(slot.view, 0, hex(vector.frame_offset as string))

    expect(new Uint8Array(slot.bytes)).toEqual(bytes(vector.bytes))
  })

  test("set_tempo matches its vector", () => {
    const vector = find(vectors.commands, "command", "set_tempo")
    const slot = reusedSlot()

    protocol.writeSetTempo(
      slot.view,
      0,
      hex(vector.frame_offset as string),
      hex(vector.fields.micro_bpm as string),
    )

    expect(new Uint8Array(slot.bytes)).toEqual(bytes(vector.bytes))
    expect(protocol.readSetTempo(slot.view, 0)).toEqual({
      microBpm: hex(vector.fields.micro_bpm as string),
    })
  })
})

/** The generated codes are what a third-party host or plugin SDK implements
 *  against, and ADR-0011 counts them among what the golden vectors fix. Both
 *  sides read them from the file rather than from each other. */
test("enum codes match their vector", () => {
  const kinds = codesOf("command_kind")
  expect(protocol.CommandKind.play).toBe(kinds.play)
  expect(protocol.CommandKind.stop).toBe(kinds.stop)
  expect(protocol.CommandKind.setTempo).toBe(kinds.set_tempo)

  const errors = codesOf("engine_error")
  expect(protocol.EngineError).toEqual({
    ok: errors.ok,
    unknownCommandKind: errors.unknown_command_kind,
    badFrameCount: errors.bad_frame_count,
    badSampleRate: errors.bad_sample_rate,
    notInitialised: errors.not_initialised,
    tooManyCommands: errors.too_many_commands,
    badCommandPayload: errors.bad_command_payload,
    badFrameOffset: errors.bad_frame_offset,
    commandsOutOfOrder: errors.commands_out_of_order,
  })

  const transport = codesOf("transport_state")
  expect(protocol.TransportState.stopped).toBe(transport.stopped)
  expect(protocol.TransportState.playing).toBe(transport.playing)
})

/** A plane of samples has no byte vector, so what the two sides have to agree
 *  on is where it starts and how much of it there is. In Rust that is a static
 *  assertion; here it is arithmetic inside a generated function, and the base
 *  is deliberately not zero so that a helper ignoring it would show. */
describe("array fields", () => {
  test("the audio planes match their vector", () => {
    const left = arrayOf("left")
    const right = arrayOf("right")
    expect(protocol.AudioOutOffsets.left).toBe(left.offset)
    expect(protocol.AudioOutOffsets.right).toBe(right.offset)
    expect(protocol.AUDIO_OUT_LEFT_LENGTH).toBe(left.length)
    expect(protocol.AUDIO_OUT_RIGHT_LENGTH).toBe(right.length)
    expect(protocol.AUDIO_OUT_SIZE).toBe(
      right.offset + right.length * Float32Array.BYTES_PER_ELEMENT,
    )

    const base = protocol.AUDIO_OUT_SIZE
    const memory = new ArrayBuffer(base + protocol.AUDIO_OUT_SIZE)
    for (const [view, plane] of [
      [protocol.audioOutLeft(memory, base), left],
      [protocol.audioOutRight(memory, base), right],
    ] as const) {
      expect(view.byteOffset).toBe(base + plane.offset)
      expect(view.length).toBe(plane.length)
    }
  })

  test("the slot payload matches its vector", () => {
    const payload = arrayOf("payload")
    expect(protocol.CommandSlotOffsets.payload).toBe(payload.offset)
    expect(protocol.COMMAND_PAYLOAD_OFFSET).toBe(payload.offset)
    expect(protocol.COMMAND_SLOT_PAYLOAD_LENGTH).toBe(payload.length)
    expect(protocol.COMMAND_PAYLOAD_SIZE).toBe(payload.length)

    const base = protocol.COMMAND_SLOT_SIZE
    const ring = new ArrayBuffer(base + protocol.COMMAND_SLOT_SIZE)
    const view = protocol.commandSlotPayload(ring, base)
    expect(view.byteOffset).toBe(base + payload.offset)
    expect(view.length).toBe(payload.length)
  })
})

test("the ABI version carries the major number and the schema hash", () => {
  expect(protocol.ABI_VERSION >>> 24).toBe(protocol.ABI_MAJOR)
  expect(protocol.ABI_VERSION & 0x00ffffff).toBe(protocol.ABI_HASH & 0x00ffffff)
})
