import { MidiKey, plugins } from '@escapement/engine-description'
import { expect, it } from '@effect/vitest'
import { Command, encodeCommand, LoopTicks, PageNote } from '../src/commands'
import { NodeHandle } from '../src/handles'
import { setParam, setStripParam } from '../src/plugins'
import { fixtureEntry, fixturePath } from './fixtures'

// The Rust test in engine-core reads this fixture.

const commands = [
  Command.SetParam({ node: NodeHandle(1), param: 2, value: 0.5 }),
  setParam(plugins.tone, NodeHandle(1), 'volume', 0.25),
  Command.AfterBatch({ batch: 7 }),
  Command.NoteOn({ node: NodeHandle(1), key: MidiKey(60), velocity: 0.75, note: PageNote(7) }),
  Command.SetTempo({ bpm: 128.5 }),
  Command.SetTransport({ playing: true, loopTicks: LoopTicks(3840), arrangement: true }),
  Command.SetTransport({ playing: false, loopTicks: LoopTicks(0xffff_ffff), arrangement: false }),
  Command.PanicAudio({ code: 7 }),
  Command.HangAudio({ code: 8 }),
  Command.NoteOff({ node: NodeHandle(1), note: PageNote(7) }),
  setStripParam(NodeHandle(1), 'pan', -0.5)
]

it('commands encode to the bytes the engine reads', () => {
  const dump = commands.map((command) => fixtureEntry(command, encodeCommand(command)))
  return expect(dump.join('')).toMatchFileSnapshot(fixturePath('commands.hex'))
})

it('encoded bytes own their buffer', () => {
  const bytes = encodeCommand(Command.AfterBatch({ batch: 7 }))
  expect(bytes.byteOffset).toBe(0)
  expect(bytes.buffer.byteLength).toBe(bytes.byteLength)
})

it('a note takes a MIDI key, not a plain number', () => {
  // @ts-expect-error A plain number isn't a key.
  Command.NoteOn({ node: NodeHandle(1), key: 60, velocity: 1, note: PageNote(1) })
})

it('a loop is a whole number of ticks from 1 that fits 32 bits, so the engine takes it as itself', () => {
  expect([1, 3840, 0xffff_ffff].map(LoopTicks)).toEqual([1, 3840, 0xffff_ffff])
  const notLoops = [0, 2 ** 32, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]
  notLoops.forEach((ticks) => expect(() => LoopTicks(ticks)).toThrow('not a loop length in ticks'))
  // @ts-expect-error A plain number isn't a loop length.
  Command.SetTransport({ playing: true, loopTicks: 3840, arrangement: false })
})

it("a live note is named below 2^31, as the pattern's notes take the rest", () => {
  expect([0, 7, 2 ** 31 - 1].map(PageNote)).toEqual([0, 7, 2 ** 31 - 1])
  const notNotes = [2 ** 31, -1, 0.5, Number.NaN]
  notNotes.forEach((note) => expect(() => PageNote(note)).toThrow())
})
