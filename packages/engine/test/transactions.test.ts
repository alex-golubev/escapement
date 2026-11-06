import { MidiKey, Sha256, Tick } from '@escapement/engine-description'
import { Option } from 'effect'
import { ByteBuffer } from 'flatbuffers'
import { RingBuffer } from 'ringbuf.js'
import { expect, test } from 'vitest'
import { createCommandRing, messageWriter } from '../src/command-ring'
import { encodeCommand } from '../src/commands'
import { DeviceEdit, encodeBatch } from '../src/device-edits'
import { handleOf, NodeHandle, PatternHandle } from '../src/handles'
import * as Wire from '../src/schema/engine'
import { meterCount } from '../src/protocol'
import { transactionWriter, type Written } from '../src/transactions'
import { batchOf, filter, marker, setVolume, tone } from './harness'

const readAll = (storage: SharedArrayBuffer) => {
  const ring = new RingBuffer(storage, Uint8Array)
  const bytes = new Uint8Array(ring.availableRead())
  ring.pop(bytes)
  return bytes
}

const numberOf = (written: Written) => Option.getOrUndefined(Option.map(batchOf(written), ({ number }) => number))

const volume = setVolume(0.5)

test('live edits alone go into the ring as they are', () => {
  const ring = createCommandRing()
  expect(transactionWriter(messageWriter(ring))({ commands: [volume] })).toEqual({})
  expect(readAll(ring)).toEqual(encodeCommand(volume))
})

test('each batch takes the next number, and its marker goes before the live edits', () => {
  const ring = createCommandRing()
  const write = transactionWriter(messageWriter(ring))
  const edits = [DeviceEdit.Reset({ epoch: 1 })]
  const numbers = [write({ edits, commands: [volume] }), write({ commands: [volume] }), write({ edits })].map(numberOf)
  expect(numbers).toEqual([1, undefined, 2])
  const expected = [marker(1), encodeCommand(volume), encodeCommand(volume), marker(2)]
  expect(readAll(ring)).toEqual(new Uint8Array(Buffer.concat(expected)))
})

test('a transaction without room in the ring sends nothing and leaves its number to the next', () => {
  const ring = createCommandRing(marker(1).length)
  const write = transactionWriter(messageWriter(ring))
  const edits = [DeviceEdit.Reset({ epoch: 1 })]
  expect(write({ edits, commands: [volume] })).toBe(false)
  expect(readAll(ring).length).toBe(0)
  expect(numberOf(write({ edits }))).toBe(1)
})

type SchemaEdit = Exclude<keyof typeof Wire.DeviceEdit, 'NONE'>

const valuesOf = (length: number, at: (i: number) => Wire.ParamValue | null) =>
  Array.from({ length }, (_, i) => {
    const value = at(i)
    return { param: value?.param() ?? 0, value: value?.value() ?? 0 }
  })

const decoders: { readonly [K in SchemaEdit]: (edit: Wire.Edit) => DeviceEdit } = {
  Reset: (edit) => DeviceEdit.Reset({ epoch: (edit.edit(new Wire.Reset()) as Wire.Reset).epoch() }),
  CreateNode: (edit) => {
    const create = edit.edit(new Wire.CreateNode()) as Wire.CreateNode
    const params = valuesOf(create.paramsLength(), (i) => create.params(i))
    const strip = valuesOf(create.stripLength(), (i) => create.strip(i))
    const samples = Array.from({ length: create.samplesLength() }, (_, i) => {
      const sound = create.samples(i)
      const bytes = Array.from({ length: 32 }, (_, byte) => sound?.hash(byte) ?? 0)
      const hash = Sha256(bytes.map((byte) => byte.toString(16).padStart(2, '0')).join(''))
      return { sample: sound?.sample() ?? 0, hash }
    })
    const node = NodeHandle(create.node())
    return DeviceEdit.CreateNode({ node, plugin: create.plugin(), version: create.version(), params, samples, strip })
  },
  SetOutput: (edit) =>
    DeviceEdit.SetOutput({ node: NodeHandle((edit.edit(new Wire.SetOutput()) as Wire.SetOutput).node()) }),
  Connect: (edit) => {
    const connect = edit.edit(new Wire.Connect()) as Wire.Connect
    return DeviceEdit.Connect({ from: NodeHandle(connect.from()), to: NodeHandle(connect.to()) })
  },
  DestroyNode: (edit) =>
    DeviceEdit.DestroyNode({ node: NodeHandle((edit.edit(new Wire.DestroyNode()) as Wire.DestroyNode).node()) }),
  SetPattern: (edit) => {
    const set = edit.edit(new Wire.SetPattern()) as Wire.SetPattern
    const notes = Array.from({ length: set.notesLength() }, (_, i) => {
      const note = set.notes(i)
      return {
        tick: Tick(note?.tick() ?? 0),
        node: NodeHandle(note?.node() ?? 0),
        key: MidiKey(note?.key() ?? 0),
        velocity: note?.velocity() ?? 0,
        length: note?.length() ?? 0
      }
    })
    return DeviceEdit.SetPattern({ pattern: PatternHandle(set.pattern()), notes })
  },
  DestroyPattern: (edit) =>
    DeviceEdit.DestroyPattern({
      pattern: PatternHandle((edit.edit(new Wire.DestroyPattern()) as Wire.DestroyPattern).pattern())
    }),
  SetClips: (edit) => {
    const set = edit.edit(new Wire.SetClips()) as Wire.SetClips
    const clips = Array.from({ length: set.clipsLength() }, (_, i) => {
      const clip = set.clips(i)
      return {
        tick: Tick(clip?.tick() ?? 0),
        length: clip?.length() ?? 0,
        period: clip?.period() ?? 0,
        offset: clip?.offset() ?? 0,
        pattern: PatternHandle(clip?.pattern() ?? 0)
      }
    })
    return DeviceEdit.SetClips({ clips })
  },
  CreateInsert: (edit) => {
    const create = edit.edit(new Wire.CreateInsert()) as Wire.CreateInsert
    const strip = valuesOf(create.stripLength(), (i) => create.strip(i))
    return DeviceEdit.CreateInsert({
      node: NodeHandle(create.node()),
      strip,
      meter: Option.fromNullishOr(create.meter())
    })
  },
  Disconnect: (edit) => {
    const disconnect = edit.edit(new Wire.Disconnect()) as Wire.Disconnect
    return DeviceEdit.Disconnect({ from: NodeHandle(disconnect.from()), to: NodeHandle(disconnect.to()) })
  },
  LetGoOfNotes: (edit) =>
    DeviceEdit.LetGoOfNotes({ node: NodeHandle((edit.edit(new Wire.LetGoOfNotes()) as Wire.LetGoOfNotes).node()) }),
  PanicBuild: (edit) => DeviceEdit.PanicBuild({ code: (edit.edit(new Wire.PanicBuild()) as Wire.PanicBuild).code() }),
  HangBuild: (edit) => DeviceEdit.HangBuild({ code: (edit.edit(new Wire.HangBuild()) as Wire.HangBuild).code() })
}

const decodeBatch = (bytes: Uint8Array): ReadonlyArray<DeviceEdit> => {
  const batch = Wire.DeviceBatch.getRootAsDeviceBatch(new ByteBuffer(bytes))
  return Array.from({ length: batch.editsLength() }, (_, i) => {
    const decoded = Option.flatMap(Option.fromNullishOr(batch.edits(i)), (edit) =>
      Option.fromUndefinedOr(Wire.DeviceEdit[edit.editType()] as SchemaEdit | 'NONE' | undefined).pipe(
        Option.filter((kind): kind is SchemaEdit => kind !== 'NONE'),
        Option.map((kind) => decoders[kind](edit))
      )
    )
    return Option.getOrThrowWith(decoded, () => new Error(`No edit at ${i}`))
  })
}

test('a batch reads back as its edits, in order, in a buffer of its own', () => {
  const edits = [
    DeviceEdit.Reset({ epoch: 3 }),
    DeviceEdit.CreateNode({
      node: filter,
      plugin: 1,
      version: 1,
      params: [
        { param: 1, value: 0.25 },
        { param: 2, value: 0.5 }
      ],
      samples: [
        { sample: 1, hash: Sha256('0f'.repeat(32)) },
        { sample: 2, hash: Sha256(`ff${'a1'.repeat(30)}00`) }
      ],
      strip: [
        { param: 2, value: -0.5 },
        { param: 1, value: 0.75 }
      ]
    }),
    DeviceEdit.SetOutput({ node: filter }),
    DeviceEdit.Connect({ from: tone, to: filter }),
    DeviceEdit.DestroyNode({ node: handleOf(1, 2) }),
    DeviceEdit.SetPattern({
      pattern: PatternHandle(0xffff_ffff),
      notes: [
        { tick: Tick(0xffff_ffff), node: handleOf(2, 3), key: MidiKey(127), velocity: 0.5, length: 0xffff_ffff },
        { tick: Tick(0), node: tone, key: MidiKey(60), velocity: 1, length: 1 }
      ]
    }),
    DeviceEdit.SetPattern({ pattern: PatternHandle(1), notes: [] }),
    DeviceEdit.DestroyPattern({ pattern: PatternHandle((2 << 16) | 5) }),
    DeviceEdit.SetClips({
      clips: [
        {
          tick: Tick(0xffff_ffff),
          length: 0xffff_ffff,
          period: 0xffff_ffff,
          offset: 0xffff_ffff,
          pattern: PatternHandle(0xffff_ffff)
        },
        { tick: Tick(0), length: 1, period: 3, offset: 2, pattern: PatternHandle(1) }
      ]
    }),
    DeviceEdit.SetClips({ clips: [] }),
    DeviceEdit.CreateInsert({ node: handleOf(3, 4), strip: [{ param: 1, value: 0.5 }], meter: Option.none() }),
    // The last meter, and one past it, which only the engine refuses.
    DeviceEdit.CreateInsert({ node: handleOf(1, 5), strip: [], meter: Option.some(meterCount) }),
    DeviceEdit.CreateInsert({ node: handleOf(1, 6), strip: [], meter: Option.some(0xffff_ffff) }),
    DeviceEdit.Disconnect({ from: tone, to: handleOf(3, 4) }),
    DeviceEdit.LetGoOfNotes({ node: tone }),
    DeviceEdit.PanicBuild({ code: 7 }),
    DeviceEdit.HangBuild({ code: 8 })
  ]
  const bytes = encodeBatch(edits)
  expect(decodeBatch(bytes)).toEqual(edits)
  expect(bytes.byteOffset).toBe(0)
  expect(bytes.buffer.byteLength).toBe(bytes.byteLength)
})
