import { MidiKey, plugins, Tick } from '@escapement/engine-description'
import { Option } from 'effect'
import { RingBuffer } from 'ringbuf.js'
import { expect, test } from 'vitest'
import { breakStream } from '../src/command-ring'
import { Command, encodeCommand, LoopTicks, PageNote } from '../src/commands'
import { DeviceEdit } from '../src/device-edits'
import { EngineEvent } from '../src/events'
import { handleOf, NodeHandle, PatternHandle } from '../src/handles'
import { maxMessageBytes } from '../src/protocol'
import { createInsert, createNode, paramNumber, setParam, setStripParam } from '../src/plugins'
import * as Wire from '../src/schema/engine'
import {
  fullVolumePeak,
  insert,
  live,
  missingNode,
  noKind,
  rampBlocks,
  rejected,
  setVolume,
  startEngine,
  tone,
  toneEdits,
  unknownKind,
  wrongSize
} from './harness'

test('the engine plays in the shared memory the page creates', () => {
  const engine = startEngine()
  expect(engine.memory.buffer).toBeInstanceOf(SharedArrayBuffer)
  expect(engine.settledPeak()).toBeCloseTo(fullVolumePeak / 2, 3)
})

test('views made at start outlive growth of the shared memory', () => {
  const engine = startEngine()
  engine.peak()
  engine.memory.grow(16)
  engine.send(live(setVolume(0.25)))
  expect(engine.settledPeak()).toBeCloseTo(fullVolumePeak * 0.25, 3)
})

test('a render quantum the engine was not built for is refused', () => {
  const { render } = startEngine()
  expect(() => render([new Float32Array(256), new Float32Array(256)])).toThrow(/Render quantum of 2 × 256 frames/)
  expect(() => render([new Float32Array(128)])).toThrow(/Render quantum of 1 × 128 frames/)
  expect(() => render([])).toThrow(/Render quantum of 0 × 0 frames/)
})

test('the initial state is heard from the first block, with its values and the live edits behind it', () => {
  const silent = [{ edits: toneEdits(0) }, { edits: toneEdits(), commands: [setVolume(0)] }]
  silent.forEach((initial) => {
    const engine = startEngine({ initial })
    expect(engine.peak()).toBe(0)
    expect(engine.readTelemetry()?.peaks).toEqual([0, 0])
  })
  // The output's connection rises, alike at any volume.
  const atDefault = startEngine().peak()
  expect(atDefault).toBeGreaterThan(0)
  expect(startEngine({ initial: { edits: toneEdits(0.25) } }).peak() / atDefault).toBeCloseTo(0.5, 3)
})

/**
 * Both parts of the engine, its two buffers, the tables of cells, of places and of patterns, the build thread's record
 * with the first hash keys, the parcel queues, the room for held parcels and the room for held notes.
 */
const engineNewHeapCalls = 17

test('every telemetry field reaches the page in its own place', () => {
  // Ring room for one of three rejections.
  const engine = startEngine({ eventRing: Math.floor(rejectionBytes() * 1.5) })
  // A node takes 32 notes a block: the tone's chord loses 5 when the transport passes it.
  const chord = Array.from({ length: 37 }, (_, key) => ({
    tick: Tick(0),
    node: tone,
    key: MidiKey(key),
    velocity: 1,
    length: 1
  }))
  expect(engine.readTelemetry()).toEqual({
    blocks: 0,
    epoch: 0,
    lostEvents: 0,
    lostNotes: 0,
    heapCalls: 0,
    peaks: [0, 0],
    playing: false,
    position: 0,
    loopTicks: 0,
    arrangement: false,
    tempo: 0,
    streamLost: false,
    overs: [0, 0],
    meters: [],
    frame: 0
  })
  engine.send({
    edits: [
      DeviceEdit.Reset({ epoch: 7 }),
      ...toneEdits(),
      DeviceEdit.SetPattern({ pattern: PatternHandle(1), notes: chord }),
      DeviceEdit.SetClips({ clips: [{ tick: Tick(0), length: 1, period: 1, offset: 0, pattern: PatternHandle(1) }] })
    ],
    commands: [
      missingNode,
      missingNode,
      missingNode,
      Command.SetTempo({ bpm: 96 }),
      Command.SetTransport({ playing: true, loopTicks: LoopTicks(19_207), arrangement: true })
    ]
  })
  // No command makes the audio thread touch the heap; this does.
  engine.audioThread.engine_new(48_000)
  const peak = engine.settledPeak()
  const telemetry = engine.readTelemetry()
  // Played from the first block; the board shows the last one's start, and at 96 and 48 kHz a tick is 31.25 frames.
  const position = Math.floor((rampBlocks * 128) / 31.25)
  const counts = [
    rampBlocks + 1,
    7,
    3 - engine.readEvents().length,
    5,
    engineNewHeapCalls,
    position,
    19_207,
    96,
    rampBlocks * 128
  ]
  expect(telemetry).toMatchObject({
    blocks: counts[0],
    epoch: counts[1],
    lostEvents: counts[2],
    lostNotes: counts[3],
    heapCalls: counts[4],
    position: counts[5],
    loopTicks: counts[6],
    tempo: counts[7],
    frame: counts[8],
    playing: true,
    arrangement: true,
    streamLost: false
  })
  // Distinct counts, so fields that swap places can't pass.
  expect(new Set(counts).size).toBe(counts.length)
  expect(telemetry?.peaks[0]).toBeCloseTo(peak, 3)
  expect(telemetry?.peaks[1]).toBeCloseTo(peak, 3)
})

test("an insert's meter reaches the page under its number, after its strip", () => {
  const engine = startEngine()
  const insert = handleOf(0, 5)
  engine.send({
    edits: [
      createInsert(insert, { volume: 0.5, pan: 0 }, Option.some(9)),
      DeviceEdit.Connect({ from: tone, to: insert })
    ]
  })
  const peak = engine.settledPeak()
  const meters = Option.getOrThrow(Option.fromUndefinedOr(engine.readTelemetry())).meters
  expect(meters.map(({ meter, overs }) => ({ meter, overs }))).toEqual([{ meter: 9, overs: [0, 0] }])
  expect(meters[0].peaks[0]).toBeCloseTo(peak / 2, 3)
  expect(meters[0].peaks[1]).toBeCloseTo(peak / 2, 3)
  expect(engine.readEvents()).toEqual([])
})

test('a volume sent through the ring changes the rendered tone', () => {
  const engine = startEngine()
  expect(engine.settledPeak()).toBeCloseTo(fullVolumePeak / 2, 3)
  engine.send(live(setVolume(0.25)))
  const first = engine.peak()
  expect(first).toBeLessThan(fullVolumePeak / 2)
  expect(first).toBeGreaterThan(fullVolumePeak * 0.25)
  expect(engine.settledPeak()).toBeCloseTo(fullVolumePeak * 0.25, 3)
})

test('messages that wrap around the end of the ring arrive intact', () => {
  // Two and a half messages, so writes keep wrapping.
  const engine = startEngine({ commandRing: Math.floor(encodeCommand(setVolume(0.5)).length * 2.5) })
  // The initial marker is read in the first block.
  engine.peak()
  const volumes = [0.9, 0.3, 0.7, 0.1, 0.6, 0.2, 0.8, 0.4]
  volumes.forEach((volume) => {
    expect(engine.send(live(setVolume(volume)))).toBe(true)
    expect(engine.settledPeak()).toBeCloseTo(fullVolumePeak * volume, 3)
  })
})

test('after a size prefix near the 32-bit limit, the engine plays on, reports it once and takes no more commands', () => {
  const engine = startEngine()
  new RingBuffer(engine.commandRing, Uint8Array).push(new Uint8Array([0xfc, 0xff, 0xff, 0xff]))
  engine.peak()
  engine.send(live(setVolume(0.25)))
  expect(engine.settledPeak()).toBeCloseTo(fullVolumePeak / 2, 3)
  expect(engine.readEvents()).toEqual([EngineEvent.CommandStreamLost({ epoch: 0 })])
  expect(engine.readTelemetry()?.blocks).toBe(rampBlocks + 2)
})

test("a size prefix just past the limit, as the page's Break stream writes it, loses the stream as well", () => {
  const engine = startEngine()
  engine.peak()
  expect(engine.readTelemetry()?.streamLost).toBe(false)
  expect(breakStream(engine.sendBytes)).toBe(true)
  engine.send(live(setVolume(0.25)))
  expect(engine.settledPeak()).toBeCloseTo(fullVolumePeak / 2, 3)
  expect(engine.readEvents()).toEqual([EngineEvent.CommandStreamLost({ epoch: 0 })])
  expect(engine.readTelemetry()?.streamLost).toBe(true)
})

test('a lost stream stays on the board when the event about it finds no room', () => {
  // Room for one rejection, and two come before the stream breaks.
  const engine = startEngine({ eventRing: rejectionBytes() })
  engine.send(live(missingNode, missingNode))
  breakStream(engine.sendBytes)
  engine.peak()
  expect(engine.readEvents()).toEqual([rejected('UnknownTarget')])
  engine.peak()
  expect(engine.readTelemetry()).toMatchObject({ lostEvents: 2, streamLost: true })
})

test('a command the engine refuses comes back as an event with the reason', () => {
  const engine = startEngine()
  engine.sendBytes([
    wrongSize(),
    noKind(),
    unknownKind(),
    encodeCommand(missingNode),
    encodeCommand(Command.SetParam({ node: tone, param: 0, value: 0.5 })),
    encodeCommand(Command.SetParam({ node: tone, param: plugins.tone.params.length + 1, value: 0.5 })),
    encodeCommand(
      Command.SetParam({ node: handleOf(1, tone), param: paramNumber(plugins.tone, 'volume'), value: 0.5 })
    ),
    encodeCommand(setVolume(Number.NaN))
  ])
  expect(engine.settledPeak()).toBeCloseTo(fullVolumePeak / 2, 3)
  expect(engine.readEvents()).toEqual([
    rejected('Malformed'),
    rejected('Malformed'),
    rejected('UnknownCommand'),
    rejected('UnknownTarget'),
    rejected('UnknownTarget'),
    rejected('UnknownTarget'),
    rejected('UnknownTarget'),
    rejected('InvalidValue')
  ])
  expect(engine.readTelemetry()?.lostEvents).toBe(0)
})

test('events carry the session they happened in', () => {
  const engine = startEngine()
  engine.send(live(missingNode))
  engine.send({ edits: [DeviceEdit.Reset({ epoch: 3 })], commands: [missingNode] })
  engine.peak()
  expect(engine.readEvents()).toEqual([rejected('UnknownTarget', 0), rejected('UnknownTarget', 3)])
})

test('events wait in the event ring until the page reads them', () => {
  const engine = startEngine()
  engine.send(live(missingNode))
  engine.peak()
  engine.send(live(missingNode))
  engine.peak()
  expect(engine.readEvents()).toEqual([rejected('UnknownTarget'), rejected('UnknownTarget')])
  expect(engine.readEvents()).toEqual([])
})

const rejectionBytes = () => {
  const engine = startEngine()
  engine.send(live(missingNode))
  engine.peak()
  return new RingBuffer(engine.eventRing, Uint8Array).availableRead()
}

test('events that find the event ring full are lost whole and counted on the telemetry board', () => {
  // Room for one event and a half.
  const engine = startEngine({ eventRing: Math.floor(rejectionBytes() * 1.5) })
  engine.send(live(missingNode, missingNode, missingNode))
  engine.peak()
  expect(engine.readEvents()).toEqual([rejected('UnknownTarget')])
  expect(engine.readTelemetry()?.lostEvents).toBe(2)
  // Once the page has read, there is room again.
  engine.send(live(missingNode))
  engine.peak()
  expect(engine.readEvents()).toEqual([rejected('UnknownTarget')])
  expect(engine.readTelemetry()?.lostEvents).toBe(2)
})

/** Each kind the schema has that `sent` leaves out. */
const leftOut = (kinds: Record<string, string | number>, sent: ReadonlyArray<{ readonly _tag: string }>) =>
  Object.keys(kinds).filter(
    (kind) => Number.isNaN(Number(kind)) && kind !== 'NONE' && !sent.some(({ _tag }) => _tag === kind)
  )

test('the audio thread never touches the heap, from its start on', () => {
  // Every command and edit there is, refused ones; the ring has room, so only the engine's buffer overflows.
  const roomy = startEngine({ eventRing: 128 * 1024 })
  // An insert has no parameters, and lets notes pass.
  const commands = [
    setVolume(0.3),
    missingNode,
    setVolume(Number.NaN),
    setParam(plugins.tone, insert, 'volume', 0.3),
    setStripParam(tone, 'pan', 0.5),
    setStripParam(insert, 'volume', 0.5),
    Command.SetStripParam({ node: tone, param: 3, value: 0 }),
    Command.NoteOn({ node: tone, key: MidiKey(60), velocity: 1, note: PageNote(1) }),
    Command.NoteOn({ node: insert, key: MidiKey(60), velocity: 1, note: PageNote(2) }),
    Command.NoteOff({ node: tone, note: PageNote(1) }),
    Command.NoteOff({ node: insert, note: PageNote(2) }),
    Command.SetTempo({ bpm: 140 }),
    Command.SetTransport({ playing: true, loopTicks: LoopTicks(4), arrangement: false })
  ]
  roomy.send(live(...commands))
  const edits = [
    createNode(plugins.tone, NodeHandle(40)),
    DeviceEdit.CreateNode({ node: NodeHandle(40), plugin: 0, version: 1, params: [], samples: [], strip: [] }),
    DeviceEdit.SetOutput({ node: NodeHandle(40) }),
    DeviceEdit.SetPattern({
      pattern: PatternHandle(1),
      notes: [{ tick: Tick(0), node: NodeHandle(40), key: MidiKey(60), velocity: 1, length: 1 }]
    }),
    DeviceEdit.SetClips({ clips: [{ tick: Tick(0), length: 4, period: 4, offset: 0, pattern: PatternHandle(1) }] }),
    DeviceEdit.DestroyPattern({ pattern: PatternHandle(2) }),
    DeviceEdit.DestroyNode({ node: NodeHandle(40) }),
    DeviceEdit.Reset({ epoch: 2 }),
    ...toneEdits(0.4),
    DeviceEdit.Disconnect({ from: tone, to: insert }),
    DeviceEdit.Disconnect({ from: tone, to: insert }),
    DeviceEdit.LetGoOfNotes({ node: tone }),
    DeviceEdit.LetGoOfNotes({ node: NodeHandle(40) })
  ]
  roomy.send({ edits, commands: [setVolume(0.3)] })
  roomy.builder.build({ _tag: 'Batch', number: 3, bytes: new Uint8Array([1, 2, 3]) })
  // Batch 3 is next in line, so the marker for 7 is refused rather than waited on.
  const markers = [7, 3].map((batch) => Command.AfterBatch({ batch }))
  roomy.sendBytes([...markers.map(encodeCommand), wrongSize(), unknownKind(), noKind()])
  // A panic or a hang ends the engine.
  expect(leftOut(Wire.DeviceEdit, edits)).toEqual(['PanicBuild', 'HangBuild'])
  expect(leftOut(Wire.CommandKind, [...commands, ...markers])).toEqual(['PanicAudio', 'HangAudio'])
  // The reset's parcel goes back once its fades are over.
  Array.from({ length: rampBlocks }, roomy.peak)
  expect(roomy.builder.collect()).toBe(0)
  // A block's budget of the shortest rejected messages.
  const flood = Array.from({ length: Math.floor(maxMessageBytes / noKind().length) }, noKind)
  roomy.sendBytes(flood)
  roomy.peak()
  const lostInEngine = roomy.readTelemetry()?.lostEvents ?? 0
  expect(lostInEngine).toBeGreaterThan(0)
  expect(lostInEngine).toBeLessThan(flood.length)
  // Ten rejections, ring room for four.
  const cramped = startEngine({ eventRing: 4 * rejectionBytes() })
  cramped.send(live(...Array.from({ length: 10 }, () => missingNode)))
  cramped.peak()
  expect(cramped.readTelemetry()?.lostEvents).toBe(6)
  new RingBuffer(cramped.commandRing, Uint8Array).push(new Uint8Array([0xfc, 0xff, 0xff, 0xff]))
  cramped.peak()
  expect([roomy, cramped].map((engine) => engine.readTelemetry()?.heapCalls)).toEqual([0, 0])
})
