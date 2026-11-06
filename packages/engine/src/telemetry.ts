import { meterCount } from './protocol'

// Word 0 is a sequence number, odd while the worklet writes; then come the words of `Telemetry` in engine-core, and last
// the worklet's own.
const sequence = 0
const blocks = 1
const epoch = 2
const lostEvents = 3
const lostNotes = 4
const heapCalls = 5
const peaks = [6, 7] as const
const playing = 8
const position = 9
const loopTicks = 10
const arrangement = 11
const tempo = 12
const streamLost = 13
const overs = [14, 15] as const
const metersUsed = 16
const metersStart = 17
/** A meter's record: its number, then its peaks and its overs per channel. */
const meterWords = 5

export const engineTelemetryWords = metersStart - 1 + meterCount * meterWords
const frame = { low: 1 + engineTelemetryWords, high: 2 + engineTelemetryWords } as const
const boardWords = 1 + engineTelemetryWords + 2

export interface Telemetry {
  readonly blocks: number
  readonly epoch: number
  /** Events that found no room on the way to the page. */
  readonly lostEvents: number
  /** Notes of the pattern that found no room: in the block's budget, or in their node's block. */
  readonly lostNotes: number
  /** By the audio thread since it started; must stay 0. */
  readonly heapCalls: number
  /** 1 is full scale. */
  readonly peaks: readonly [number, number]
  readonly playing: boolean
  /** Whole ticks from the loop's start at the last block's start; 0 while stopped. */
  readonly position: number
  /** The loop's ticks at the last block's start, the length the position goes round in; 0 while stopped. */
  readonly loopTicks: number
  /** Whether the loop at the last block's start plays the arrangement, as the page said with it; not while stopped. */
  readonly arrangement: boolean
  /** Quarter notes a minute in the last block. */
  readonly tempo: number
  /** Once the engine lost its command stream: it takes no more commands. */
  readonly streamLost: boolean
  /** Blocks that went over full scale, per channel, wrapping: the count moves however briefly the sound went over. */
  readonly overs: readonly [number, number]
  /** Of the nodes the page gave a meter, in no order. */
  readonly meters: ReadonlyArray<MeterReading>
  /** The context's frame the last block started at. */
  readonly frame: number
}

/** A node's meter, as the master's output: the count goes on by its number, whichever node has it. */
export interface MeterReading {
  /** The number the page gave it, from 1. */
  readonly meter: number
  readonly peaks: readonly [number, number]
  readonly overs: readonly [number, number]
}

export const createTelemetryBoard = (): SharedArrayBuffer => new SharedArrayBuffer(boardWords * 4)

const wordSpan = 2 ** 32

/** Runs on the audio thread every block, with the context's frame the block started at. */
export const telemetryWriter = (board: SharedArrayBuffer) => {
  const words = new Uint32Array(board)
  return (engineWords: Uint32Array, blockFrame: number) => {
    const next = Atomics.load(words, sequence) + 1
    Atomics.store(words, sequence, next)
    // The records in use only: the rest stand as they were, past the count the page reads up to.
    const copied = metersStart - blocks + Math.min(engineWords[metersUsed - blocks], meterCount) * meterWords
    for (let i = 0; i < copied; i++) Atomics.store(words, blocks + i, engineWords[i])
    Atomics.store(words, frame.low, blockFrame % wordSpan)
    Atomics.store(words, frame.high, Math.floor(blockFrame / wordSpan))
    Atomics.store(words, sequence, next + 1)
  }
}

// A write takes nanoseconds, so a few tries are plenty.
const readAttempts = 4

/** A consistent snapshot, or undefined if the worklet kept writing through every try. */
export const telemetryReader = (board: SharedArrayBuffer) => {
  const words = new Uint32Array(board)
  // Atomics works on integers only.
  const float = new Float32Array(1)
  const floatBits = new Uint32Array(float.buffer)
  const floatAt = (index: number) => {
    floatBits[0] = Atomics.load(words, index)
    return float[0]
  }
  const read = (): Telemetry => ({
    blocks: Atomics.load(words, blocks),
    epoch: Atomics.load(words, epoch),
    lostEvents: Atomics.load(words, lostEvents),
    lostNotes: Atomics.load(words, lostNotes),
    heapCalls: Atomics.load(words, heapCalls),
    peaks: [floatAt(peaks[0]), floatAt(peaks[1])],
    playing: Atomics.load(words, playing) !== 0,
    position: Atomics.load(words, position),
    loopTicks: Atomics.load(words, loopTicks),
    arrangement: Atomics.load(words, arrangement) !== 0,
    tempo: floatAt(tempo),
    streamLost: Atomics.load(words, streamLost) !== 0,
    overs: [Atomics.load(words, overs[0]), Atomics.load(words, overs[1])],
    meters: Array.from({ length: Math.min(Atomics.load(words, metersUsed), meterCount) }, (_, i) => {
      const at = metersStart + i * meterWords
      return {
        meter: Atomics.load(words, at),
        peaks: [floatAt(at + 1), floatAt(at + 2)],
        overs: [Atomics.load(words, at + 3), Atomics.load(words, at + 4)]
      }
    }),
    frame: Atomics.load(words, frame.high) * wordSpan + Atomics.load(words, frame.low)
  })
  return (): Telemetry | undefined => {
    for (let attempt = 0; attempt < readAttempts; attempt++) {
      const before = Atomics.load(words, sequence)
      if (before % 2 !== 0) continue
      const snapshot = read()
      if (Atomics.load(words, sequence) === before) return snapshot
    }
    return undefined
  }
}
