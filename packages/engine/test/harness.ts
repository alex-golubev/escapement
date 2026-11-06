/// <reference types="vite/client" />
import { defaultTempo, plugins, Sha256, ticksPerQuarter } from '@escapement/engine-description'
import { Boolean, Cause, Deferred, Effect, Exit, Match, Option, Result } from 'effect'
import { Base64 } from 'effect/encoding'
import { RingBuffer } from 'ringbuf.js'
import { buildEngine } from '../src/build-thread/build-engine'
import { sampleQueue } from '../src/build-thread/sample-queue'
import { breakStream, createCommandRing, messageWriter } from '../src/command-ring'
import { Command, encodeCommand } from '../src/commands'
import { DeviceEdit } from '../src/device-edits'
import type { Engine } from '../src/engine'
import { BuildThreadError, ProcessorError } from '../src/errors'
import { createEventRing, eventReader, eventStream } from '../src/event-ring'
import { EngineEvent } from '../src/events'
import type { Rejection } from '../src/rejections'
import { encodeMessage } from '../src/framing'
import { NodeHandle } from '../src/handles'
import { memoryPages } from '../src/memory'
import { setParam } from '../src/plugins'
import { blockFrames, type FromBuildThread, type SampleAnswer, type StoreSample } from '../src/protocol'
import { type BuildThreadPort, sampleStore } from '../src/sample-store'
import { CommandKind, SetParam } from '../src/schema/engine'
import { lostStream } from '../src/lost-stream'
import { createTelemetryBoard, telemetryReader } from '../src/telemetry'
import { addFilter, addTone, emptyTestGraph } from './test-graph'
import { startAudioThread } from '../src/threads'
import {
  type LiveCommand,
  type Transaction,
  transactionSender,
  transactionWriter,
  type Written,
  writeInitial
} from '../src/transactions'
import { createEngineBlock } from '../src/worklet/engine-block'
import engineWasm from '../wasm/engine.wasm?inline'

// The release build: 32-bit, unlike `cargo test`. Vite hands it over as a data URL.
export const module = new WebAssembly.Module(
  // A copy is an `ArrayBuffer`'s, as `BufferSource` wants; the decoder's may sit on any buffer.
  Result.getOrThrow(Base64.decode(engineWasm.slice(engineWasm.indexOf(',') + 1))).slice()
)

export const sampleRate = 48_000

/** At the default tempo: 25. */
export const framesPerTick = (sampleRate * 60) / (defaultTempo * ticksPerQuarter)

/** Blocks that hold `frames` frames. */
export const blocksOf = (frames: number) => Math.ceil(frames / blockFrames)

// Peak at full volume, and blocks per volume change (20 ms at 48 kHz).
export const fullVolumePeak = 0.2
export const rampBlocks = 8

const toneAdded = (volume?: number) => Option.getOrThrow(addTone(emptyTestGraph, { volume }))

const filterAdded = (cutoff?: number) => Option.getOrThrow(addFilter(toneAdded().graph, { cutoff }))

/** A tone added to an empty graph: the tone into the insert, the insert on the output. */
export const toneEdits = (volume?: number) => toneAdded(volume).transaction.edits ?? []

/** A filter added after that: between the insert and the output. */
export const filterEdits = (cutoff?: number) => filterAdded(cutoff).transaction.edits ?? []

/** The handles the graph hands out, as the edits above make the nodes. */
export const insert = Option.getOrThrow(Option.fromUndefinedOr(toneAdded().graph.insert))
export const tone = Option.getOrThrow(Option.fromUndefinedOr(toneAdded().graph.tone)).node
export const filter = Option.getOrThrow(Option.fromUndefinedOr(filterAdded().graph.filter)).node

export const setVolume = (value: number) => setParam(plugins.tone, tone, 'volume', value)

/** Comes back as a rejection: no test makes a node in this cell. */
export const missingNode = setParam(plugins.tone, NodeHandle(30), 'volume', 0.5)

export const live = (...commands: ReadonlyArray<LiveCommand>): Transaction => ({ commands })

export const rejected = (reason: Rejection, epoch = 0) => EngineEvent.CommandRejected({ epoch, reason })

export const editRejected = (batch: number, reason: Rejection, epoch = 0) =>
  EngineEvent.EditRejected({ epoch, batch, reason })

// Messages the page's encoder can't produce.

/** A known kind with a record one byte short. */
export const wrongSize = () => encodeMessage(CommandKind.SetParam, new Uint8Array(SetParam.sizeOf() - 1))

export const unknownKind = () => encodeMessage(0, new Uint8Array(4))

/** The shortest message there is, so the most rejections a block's budget holds. */
export const noKind = () => new Uint8Array(4)

export const marker = (batch: number) => encodeCommand(Command.AfterBatch({ batch }))

interface Options {
  readonly commandRing?: number
  readonly eventRing?: number
  /** The test tone on the output unless given. */
  readonly initial?: Transaction
  /** In 64 KiB pages, the engine's 4 GiB unless given. */
  readonly maximumMemory?: number
}

/** The engine started the way the page starts it, with both threads' instances on this one. */
export const startEngine = ({
  commandRing,
  eventRing,
  initial = { edits: toneEdits() },
  maximumMemory = memoryPages.maximum
}: Options = {}) => {
  const memory = new WebAssembly.Memory({ ...memoryPages, maximum: maximumMemory, shared: true })
  const rings = {
    commandRing: createCommandRing(commandRing),
    eventRing: createEventRing(eventRing),
    telemetryBoard: createTelemetryBoard()
  }
  const messages = messageWriter(rings.commandRing)
  const write = transactionWriter(messages)
  const {
    wasm: buildThread,
    engine,
    builder,
    samples
  } = buildEngine({ module, memory, sampleRate, initial: writeInitial(write, initial) })
  const audioThread = startAudioThread(module, memory)
  const renderAt = createEngineBlock(audioThread, { module, memory, engine, ...rings })
  /** Renders the context's next block, as the worklet does. */
  const clock = { frame: 0 }
  const render = (channels: ReadonlyArray<Float32Array>) => {
    renderAt(channels, clock.frame)
    clock.frame += 128
  }
  /** The build thread builds each batch at once. */
  const send = transactionSender(write, (batch) => {
    builder.build(batch)
  })
  const channels = [new Float32Array(128), new Float32Array(128)]
  /** Renders a block and returns its loudest sample. */
  const peak = () => {
    render(channels)
    return channels[0].reduce((peak, sample) => Math.max(peak, Math.abs(sample)), 0)
  }
  /** Once a volume change has finished. */
  const settledPeak = () => {
    Array.from({ length: rampBlocks }, peak)
    return peak()
  }
  // The build thread's steps of storing sounds wait here for the test to run them, one task each.
  const steps: Array<() => void> = []
  const answers: Array<SampleAnswer> = []
  const queue = sampleQueue(
    samples,
    (step) => {
      steps.push(step)
    },
    (answer) => {
      answers.push(answer)
    }
  )
  /** Runs the next step of storing sounds; false if none waits. */
  const step = () => {
    const next = steps.shift()
    next?.()
    return next !== undefined
  }
  const readEvent = eventReader(rings.eventRing)
  const readEvents = (): ReadonlyArray<EngineEvent> =>
    Option.match(Option.fromUndefinedOr(readEvent()), { onNone: () => [], onSome: (event) => [event, ...readEvents()] })
  const eventRingEnd = new RingBuffer(rings.eventRing, Uint8Array)
  const readEventBytes = () => {
    const bytes = new Uint8Array(eventRingEnd.availableRead())
    eventRingEnd.pop(bytes)
    return bytes
  }
  return {
    memory,
    buildThread,
    audioThread,
    builder,
    /** The engine's side of storing sounds, called straight. */
    samples,
    /** Queued as the build thread queues the page's messages; the steps run them. */
    storeSample: (sound: StoreSample) => queue(sound),
    evictSample: (hash: Sha256) => queue({ _tag: 'EvictSample', hash }),
    step,
    answers,
    render,
    commandRing: rings.commandRing,
    eventRing: rings.eventRing,
    send,
    /** Only the ring part: the batch, if any, is for the test to build. */
    write,
    /** Also messages the page's encoder can't produce. */
    sendBytes: messages,
    peak,
    settledPeak,
    readEvents,
    readEventBytes,
    readTelemetry: telemetryReader(rings.telemetryBoard)
  }
}

export type TestEngine = ReturnType<typeof startEngine>

/** A test sound: a ramp up from 0.001, a value a frame, so any frame of it says where it is. */
export const kick = Sha256('89'.repeat(32))
export const kickSound = () => Float32Array.from({ length: 500 }, (_, i) => 0.001 * (i + 1))

/** The batch a write made, if it made one. */
export const batchOf = (written: Written) =>
  Option.flatMap(
    Option.liftPredicate(written, (written) => written !== false),
    ({ batch }) => Option.fromUndefinedOr(batch)
  )

/** Runs the build thread's steps, and those they queue, until none is left; how many ran. */
export const runSteps = (engine: TestEngine): number =>
  Boolean.match(engine.step(), { onTrue: () => 1 + runSteps(engine), onFalse: () => 0 })

/** Stores the sound under `hash`, every step of it at once, and returns the answer. */
export const storeSound = (engine: TestEngine, channels: ReadonlyArray<Float32Array>, hash: Sha256): SampleAnswer => {
  const sound: StoreSample = { _tag: 'StoreSample', id: 1, hash, sampleRate, channels }
  engine.storeSample(sound)
  runSteps(engine)
  return Option.getOrThrowWith(Option.fromUndefinedOr(engine.answers.shift()), () => new Error('No answer'))
}

/** The left channel of `count` blocks. */
export const blocks = (engine: TestEngine, count: number) => {
  const left = new Float32Array(count * 128)
  const channels = [new Float32Array(128), new Float32Array(128)]
  Array.from({ length: count }, (_, block) => {
    engine.render(channels)
    left.set(channels[0], block * 128)
  })
  return left
}

/**
 * The page's store of sounds over this engine's build thread. The build thread takes what the page sends at once, and
 * the page hears back when `settle` runs every step, as a worker's answers come in a later task.
 */
export const pageSounds = Effect.fnUntraced(function* (
  engine: TestEngine,
  buildThreadFailure: Effect.Effect<never, BuildThreadError> = Effect.never
) {
  const listeners = new Set<(event: MessageEvent<FromBuildThread>) => void>()
  const port: BuildThreadPort = {
    postMessage: (message) =>
      Match.valueTags(message, {
        StoreSample: (sound) => engine.storeSample(sound),
        EvictSample: ({ hash }) => engine.evictSample(hash)
      }),
    addEventListener: (_, listener) => {
      listeners.add(listener)
    },
    removeEventListener: (_, listener) => {
      listeners.delete(listener)
    }
  }
  const sounds = yield* sampleStore(port, buildThreadFailure)
  /** Runs the build thread's steps and hands the page their answers; whether anything moved. */
  const drain = () => {
    const stepped = runSteps(engine) > 0
    const answers = engine.answers.splice(0)
    answers.forEach((data) => listeners.forEach((listener) => listener(new MessageEvent('message', { data }))))
    return stepped || answers.length > 0
  }
  const settle = () => void drain()
  /**
   * Until nothing more reaches the build thread or comes back from it: each round gives the page's fibers a turn, then
   * runs the build thread and hands back its answers.
   */
  const settled = Effect.yieldNow.pipe(
    Effect.andThen(Effect.sync(drain)),
    Effect.repeat({ while: (moved) => moved }),
    Effect.asVoid
  )
  return { ...sounds, settle, settled }
})

/** What a failure says: the first error of its cause. A success says nothing. */
export const failureText = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.match(exit, { onSuccess: () => '', onFailure: (cause) => String(Cause.squash(cause)) })

/** Whether the engine trapped, with what its panic said or without. */
const isTrap = (error: unknown): error is Error =>
  error instanceof WebAssembly.RuntimeError ||
  (error instanceof Error && error.cause instanceof WebAssembly.RuntimeError)

/**
 * Calls into one thread's instance until it traps or hangs, then never again. A browser drops a thread that threw, and
 * `died` hears what it would say; a hung one goes on looping in silence, so it never answers a ping either.
 */
const thread = (died: (message: string) => void) => {
  const state = { alive: true, hung: false }
  return {
    call: <A>(call: () => A, dead: A): A =>
      Boolean.match(state.alive, {
        onFalse: () => dead,
        onTrue: () =>
          Result.match(Result.try(call), {
            onSuccess: (result) => result,
            onFailure: (error) =>
              Option.match(Option.liftPredicate(error, isTrap), {
                onNone: () => {
                  throw error
                },
                onSome: (trap) => {
                  state.alive = false
                  died(`Uncaught ${trap.name}: ${trap.message}`)
                  return dead
                }
              })
          })
      }),
    /** Before the instance gets to the loop: the test would loop with it. */
    hang: () => {
      state.alive = false
      state.hung = true
    },
    ping: Effect.suspend(() => Boolean.match(state.hung, { onTrue: () => Effect.never, onFalse: () => Effect.void }))
  }
}

/**
 * The engine as the page holds it, without its worklet's node, while the scope is open: the test renders its blocks and
 * settles its sounds. A panic of either thread fails it, as the browser reports one; a hang only stops the thread's
 * answers. Either way the thread does nothing after. A lost command stream fails it as it does the page's.
 */
export const pageEngine = Effect.fnUntraced(function* (engine: TestEngine) {
  const audioFailed = yield* Deferred.make<never, ProcessorError>()
  const buildFailed = yield* Deferred.make<never, BuildThreadError>()
  const onAudioThread = thread((message) =>
    Deferred.doneUnsafe(audioFailed, Effect.fail(new ProcessorError({ message })))
  )
  // The build thread builds a batch once it is sent, and stores sounds as they settle.
  const onBuildThread = thread((message) =>
    Deferred.doneUnsafe(buildFailed, Effect.fail(new BuildThreadError({ message })))
  )
  const threads = { audio: onAudioThread, build: onBuildThread }
  const sounds = yield* pageSounds(engine, Deferred.await(buildFailed))
  // The ring takes what the page writes even once the build thread is dead; only its batches go nowhere.
  const send = transactionSender(engine.write, (batch) =>
    onBuildThread.call(() => void engine.builder.build(batch), undefined)
  )
  const abandoned = { now: false }
  const held: Omit<Engine, 'node'> = {
    send: (transaction) => {
      Boolean.match(transaction.commands?.some(Command.$is('HangAudio')) === true, {
        onTrue: onAudioThread.hang,
        onFalse: () => {}
      })
      Boolean.match(transaction.edits?.some(DeviceEdit.$is('HangBuild')) === true, {
        onTrue: onBuildThread.hang,
        onFalse: () => {}
      })
      return send(transaction)
    },
    events: yield* eventStream(engine.eventRing),
    readTelemetry: engine.readTelemetry,
    failure: Effect.raceAllFirst([
      Deferred.await(audioFailed),
      Deferred.await(buildFailed),
      lostStream(engine.readTelemetry)
    ]),
    storeSample: sounds.store,
    evictSample: sounds.evict,
    ping: (which) => threads[which].ping,
    abandon: Effect.sync(() => {
      abandoned.now = true
    }),
    breakStream: () => breakStream(engine.sendBytes)
  }
  return {
    engine: held,
    settle: () => onBuildThread.call(sounds.settle, undefined),
    /** As `blocks`; silence once the audio thread is dead or hung. */
    blocks: (count: number) => onAudioThread.call(() => blocks(engine, count), new Float32Array(count * blockFrames)),
    /** Whether the page gave up its audio thread, so that nothing touches the context. */
    abandoned: () => abandoned.now
  }
})
