import { RingBuffer } from 'ringbuf.js'
import { expect, it } from '@effect/vitest'
import { DeviceEdit } from '../src/device-edits'
import { decodeEvent, EngineEvent } from '../src/events'
import { NodeHandle } from '../src/handles'
import { fixtureEntry, fixturePath } from './fixtures'
import {
  editRejected,
  live,
  missingNode,
  rejected,
  setVolume,
  startEngine,
  type TestEngine,
  toneEdits,
  wrongSize
} from './harness'

// The engine writes the fixture; the page's decoder reads the same bytes.

/** One event per block. */
const cases: ReadonlyArray<{ readonly report: (engine: TestEngine) => void; readonly event: EngineEvent }> = [
  {
    report: (engine) =>
      engine.send({ edits: [DeviceEdit.Reset({ epoch: 7 }), ...toneEdits()], commands: [missingNode] }),
    event: rejected('UnknownTarget', 7)
  },
  { report: (engine) => engine.send(live(setVolume(Number.NaN))), event: rejected('InvalidValue', 7) },
  { report: (engine) => engine.sendBytes([wrongSize()]), event: rejected('Malformed', 7) },
  {
    // The initial batch is 1 and the reset 2.
    report: (engine) =>
      engine.send({
        edits: [
          DeviceEdit.CreateNode({ node: NodeHandle(9), plugin: 0, version: 1, params: [], samples: [], strip: [] })
        ]
      }),
    event: editRejected(3, 'UnknownPlugin', 7)
  },
  {
    report: (engine) => new RingBuffer(engine.commandRing, Uint8Array).push(new Uint8Array([0xfc, 0xff, 0xff, 0xff])),
    event: EngineEvent.CommandStreamLost({ epoch: 7 })
  }
]

it('the engine writes the events of the fixture, and the page reads them', () => {
  const engine = startEngine()
  const written = cases.map(({ report }) => {
    report(engine)
    engine.peak()
    return engine.readEventBytes()
  })
  // Not the file: while `-u` rewrites it, it would still be the old one.
  expect(written.map(decodeEvent)).toEqual(cases.map(({ event }) => event))
  const dump = cases.map(({ event }, i) => fixtureEntry(event, written[i]))
  return expect(dump.join('')).toMatchFileSnapshot(fixturePath('events.hex'))
})

it('a message cut short is a bug and throws', () => {
  // The size prefix promises 8 bytes, 2 follow.
  expect(() => decodeEvent(new Uint8Array([8, 0, 0, 0, 1, 2]))).toThrow(/6 bytes, while its size prefix says 12/)
  expect(() => decodeEvent(new Uint8Array([8, 0, 0, 0]))).toThrow(/4 bytes is shorter than a size prefix and a kind/)
})

it('a record of another size than its kind is a bug and throws', () => {
  // A CommandStreamLost with a record of 2 bytes instead of 4.
  expect(() => decodeEvent(new Uint8Array([3, 0, 0, 0, 2, 7, 0]))).toThrow(/CommandStreamLost record of 2 bytes/)
  expect(() => decodeEvent(new Uint8Array([1, 0, 0, 0, 0]))).toThrow(/Unknown event kind 0/)
})
