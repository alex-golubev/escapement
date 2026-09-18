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
) as { records: Vector[]; commands: Vector[] }

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

  test("meter_block matches its vector", () => {
    const vector = find(vectors.records, "record", "meter_block")
    const block = buffer(protocol.METER_BLOCK_SIZE)
    // The fields are i32, so a vector value above 0x7fffffff is negative.
    const signed = (name: string) => hex(vector.fields[name] as string) | 0

    protocol.storeMeterBlockBlockCounter(block.atoms, 0, signed("block_counter"))
    protocol.storeMeterBlockPositionFrames(block.atoms, 0, signed("position_frames"))
    protocol.storeMeterBlockPeakMicro(block.atoms, 0, signed("peak_micro"))
    protocol.storeMeterBlockTransportState(block.atoms, 0, signed("transport_state"))

    expect(new Uint8Array(block.bytes)).toEqual(bytes(vector.bytes))
    expect(protocol.loadMeterBlockPeakMicro(block.atoms, 0)).toBe(-1)
  })

  test("meter_block reaches the same bytes through the view", () => {
    const vector = find(vectors.records, "record", "meter_block")
    const block = buffer(protocol.METER_BLOCK_SIZE)
    const signed = (name: string) => hex(vector.fields[name] as string) | 0
    const meters = new protocol.MeterBlockView(block.atoms, 0)

    meters.blockCounter = signed("block_counter")
    meters.positionFrames = signed("position_frames")
    meters.peakMicro = signed("peak_micro")
    meters.transportState = signed("transport_state")

    expect(new Uint8Array(block.bytes)).toEqual(bytes(vector.bytes))
    expect(meters.peakMicro).toBe(-1)
    expect(meters.positionFrames).toBe(signed("position_frames"))
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

test("the ABI version carries the major number and the schema hash", () => {
  expect(protocol.ABI_VERSION >>> 24).toBe(protocol.ABI_MAJOR)
  expect(protocol.ABI_VERSION & 0x00ffffff).toBe(protocol.ABI_HASH & 0x00ffffff)
})
