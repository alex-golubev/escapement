import { lastTick, type MidiKey, Tick } from '@escapement/engine-description'
import { Brand, Data } from 'effect'
import { Builder } from 'flatbuffers'
import { encodeMessage } from './framing'
import type { NodeHandle } from './handles'
import {
  AfterBatch,
  CommandKind,
  HangAudio,
  NoteOff,
  NoteOn,
  PanicAudio,
  SetParam,
  SetStripParam,
  SetTempo,
  SetTransport
} from './schema/engine'

type SchemaCommand = keyof typeof CommandKind

/** A loop's length: a whole number of ticks from 1, as many to a quarter note as `ticksPerQuarter`. */
export type LoopTicks = Brand.Branded<number, 'LoopTicks'>

/** Throws on anything else: the engine refuses a loop of no ticks, and the record holds 32 bits. */
export const LoopTicks = Brand.make<LoopTicks>(
  (ticks) => (Number.isInteger(ticks) && ticks >= 1 && ticks <= lastTick) || `not a loop length in ticks: ${ticks}`
)

/** Tells a press that puts the transport's position from every other: 0 is none, then 32 bits that wrap around. */
export type PlacePress = Brand.Branded<number, 'PlacePress'>

/** Throws on anything else: the record holds 32 bits. */
export const PlacePress = Brand.make<PlacePress>(
  (press) => (Number.isInteger(press) && press >= 0 && press < 2 ** 32) || `not a press: ${press}`
)

/** Where the page last put the transport's position: the press that did, and the tick. */
export interface Place {
  readonly press: PlacePress
  /** From the loop's start; stopped, it stands past the loop's end too, which playing wraps around. */
  readonly tick: Tick
}

/** No press: a new engine stands at the loop's start. */
export const noPlace: Place = { press: PlacePress(0), tick: Tick(0) }

/** Names a live note until it is let go of: below 2^31, as the pattern's notes take the rest. */
export type PageNote = Brand.Branded<number, 'PageNote'>

/** Throws on anything else: the engine refuses a note named past the page's. */
export const PageNote = Brand.make<PageNote>(
  (note) => (Number.isInteger(note) && note >= 0 && note < 2 ** 31) || `not a note the page may name: ${note}`
)

interface CommandFields {
  readonly SetParam: { readonly node: NodeHandle; readonly param: number; readonly value: number }
  /** Written by the transaction writer, never by hand. */
  readonly AfterBatch: { readonly batch: number }
  /** From the start of the next block; `velocity` from 0 to 1. */
  readonly NoteOn: {
    readonly node: NodeHandle
    readonly key: MidiKey
    readonly velocity: number
    readonly note: PageNote
  }
  /** From the start of the next block: the note pressed with `note`. */
  readonly NoteOff: { readonly node: NodeHandle; readonly note: PageNote }
  /** From the start of the next block; past `minTempo` to `maxTempo` it is clamped. */
  readonly SetTempo: { readonly bpm: number }
  /** The transport's whole state, not a press: the same again changes nothing; only a new place moves the position. */
  readonly SetTransport: { readonly playing: boolean; readonly loopTicks: LoopTicks; readonly place: Place }
  /** The audio thread panics, so the page's recovery can be checked; the code goes into the panic's message. */
  readonly PanicAudio: { readonly code: number }
  /** The audio thread loops for ever, so the page's recovery can be checked; the code only marks the press. */
  readonly HangAudio: { readonly code: number }
  /** A parameter of the node's strip, by its place in `strip` from 1. */
  readonly SetStripParam: { readonly node: NodeHandle; readonly param: number; readonly value: number }
}

/** Commands come from the schema: one added there doesn't compile until it has fields here. */
export type Command = Data.TaggedEnum<Pick<CommandFields, SchemaCommand>>

export const Command = Data.taggedEnum<Command>()

const writeRecord = (builder: Builder, command: Command): void => {
  Command.$match(command, {
    SetParam: ({ node, param, value }) => SetParam.createSetParam(builder, node, param, value),
    AfterBatch: ({ batch }) => AfterBatch.createAfterBatch(builder, batch),
    NoteOn: ({ node, key, velocity, note }) => NoteOn.createNoteOn(builder, node, key, velocity, note),
    NoteOff: ({ node, note }) => NoteOff.createNoteOff(builder, node, note),
    SetTempo: ({ bpm }) => SetTempo.createSetTempo(builder, bpm),
    SetTransport: ({ playing, loopTicks, place }) =>
      SetTransport.createSetTransport(builder, playing, loopTicks, place.press, place.tick),
    PanicAudio: ({ code }) => PanicAudio.createPanicAudio(builder, code),
    HangAudio: ({ code }) => HangAudio.createHangAudio(builder, code),
    SetStripParam: ({ node, param, value }) => SetStripParam.createSetStripParam(builder, node, param, value)
  })
}

/** A message that owns its buffer. */
export const encodeCommand = (command: Command): Uint8Array => {
  const builder = new Builder(16)
  writeRecord(builder, command)
  // The builder fills its buffer from the end; `asUint8Array` works only once a table buffer is finished.
  const buffer = builder.dataBuffer().bytes()
  return encodeMessage(CommandKind[command._tag], buffer.subarray(buffer.length - builder.offset()))
}
