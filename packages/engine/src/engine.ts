// The threads start from URLs Vite makes, whoever builds or checks this file.
/// <reference types="vite/client" />
import { Deferred, Effect, Option, Ref, type Stream } from 'effect'
import { HttpClient, HttpClientResponse } from 'effect/http'
import buildThreadUrl from './build-thread/worker.ts?worker&url'
import processorUrl from './worklet/processor.ts?worker&url'
import { breakStream, createCommandRing, messageWriter } from './command-ring'
import { BuildThreadError, type CommandStreamError, EngineLoadError, EngineStartError, ProcessorError } from './errors'
import { createEventRing, eventStream } from './event-ring'
import type { EngineEvent } from './events'
import { createLoadClock } from './load-clock'
import { createEngineMemory } from './memory'
import { type Answering, answered } from './ping'
import {
  type BuildThreadReady,
  type BuildThreadStart,
  channelCount,
  type EngineProcessorOptions,
  processorName,
  type StopProcessor,
  type WorkletInfo
} from './protocol'
import { type SampleStore, sampleStore } from './sample-store'
import { lostStream } from './lost-stream'
import { createTelemetryBoard, type Telemetry, telemetryReader } from './telemetry'
import { type Send, transactionSender, transactionWriter } from './transactions'

const engineUrl = new URL('../wasm/engine.wasm', import.meta.url)

/** On the main thread; the module is then handed to the worklet. */
export const compileEngine: Effect.Effect<WebAssembly.Module, EngineLoadError, HttpClient.HttpClient> = HttpClient.get(
  engineUrl
).pipe(
  Effect.flatMap(HttpClientResponse.filterStatusOk),
  Effect.mapError((cause) => new EngineLoadError({ cause })),
  // The browser's own response, compiled as it comes in.
  Effect.flatMap((response) =>
    Effect.fromOption(
      HttpClientResponse.toWeb(response),
      () => new EngineLoadError({ cause: 'the HTTP client gave no response of the browser' })
    )
  ),
  Effect.flatMap((source) =>
    Effect.tryPromise({
      try: () => WebAssembly.compileStreaming(source),
      catch: (cause) => new EngineLoadError({ cause })
    })
  )
)

export type EngineFailure = ProcessorError | BuildThreadError | CommandStreamError

/** One of the engine's threads, as the page asks after it. */
export type EngineThread = 'audio' | 'build'

export interface Engine {
  readonly node: AudioWorkletNode
  readonly send: Send
  /** For one listener at a time; events it leaves stay for the next. */
  readonly events: Stream.Stream<EngineEvent>
  /** Cheap enough for every frame. */
  readonly readTelemetry: () => Telemetry | undefined
  /** The time the worklet times its blocks by while the page measures their load: `loadClockThread` writes it. */
  readonly loadClock: SharedArrayBuffer
  /** Fails once either of the engine's threads does, or once it loses its command stream; never succeeds. */
  readonly failure: Effect.Effect<never, EngineFailure>
  /**
   * Stores the sound under its file's hash until it is evicted or the engine stops, loading and sending it only if it
   * was never stored or was evicted since. Ends once it is in; fails if the load does, the engine refuses it or the
   * build thread fails; interrupted by its eviction and when the engine stops. A sound without channels, with channels
   * of different lengths or with a channel handed over before is the caller's bug and dies here.
   */
  readonly storeSample: SampleStore['store']
  /**
   * The project no longer needs the sound: the engine frees it once no node plays it. True if it was stored or on its
   * way, and not evicted since; a load still running sends nothing.
   */
  readonly evictSample: SampleStore['evict']
  /**
   * Ends once the thread answers, which it does as soon as it is free: a hung one never does, a long busy one late.
   * Interrupted, it stops waiting.
   */
  readonly ping: (thread: EngineThread) => Effect.Effect<void>
  /**
   * The audio thread hung: from now on nothing touches its context, the engine's own release included. The browser
   * would block the page on it for as long as the tab's process lives.
   */
  readonly abandon: Effect.Effect<void>
  /**
   * Writes the size prefix of a message over the size limit, so the page's recovery can be checked: the engine plays
   * on, takes no more commands and fails. False if the ring has no room.
   */
  readonly breakStream: () => boolean
}

interface Watched<T, E> {
  /** Throws if it can't be made. */
  readonly make: () => T
  /** Adds the listeners, calling `fail` from them; returns what removes them. */
  readonly watch: (target: T, fail: (error: E) => void) => () => void
  readonly release: (target: T) => Effect.Effect<void>
}

/**
 * Makes the target and listens to it in one step, so no failure slips by before anyone awaits it; both last while
 * the scope is open. `failure` fails with the first one.
 */
const acquireWatched = <T, E>({ make, watch, release }: Watched<T, E>) =>
  Effect.acquireRelease(
    Effect.try({
      try: () => {
        const target = make()
        const failed = Deferred.makeUnsafe<never, E>()
        const stop = watch(target, (error) => Deferred.doneUnsafe(failed, Effect.fail(error)))
        return { target, failed, stop }
      },
      catch: (cause) => new EngineStartError({ cause })
    }),
    ({ target, stop }) => Effect.sync(stop).pipe(Effect.andThen(release(target)))
  ).pipe(Effect.map(({ target, failed }) => ({ target, failure: Deferred.await(failed) })))

/** What an error event says; `otherwise` for an event that says nothing. */
const messageOf = (event: Event, otherwise: string) =>
  Option.liftPredicate(event, (event): event is ErrorEvent => event instanceof ErrorEvent).pipe(
    Option.map(({ message }) => message),
    Option.filter((message) => message !== ''),
    Option.getOrElse(() => otherwise)
  )

const watchBuildThread = (worker: Worker, fail: (error: BuildThreadError) => void) => {
  // An error thrown in the worker says what; a script that didn't load comes as a plain event.
  const onError = (event: Event) =>
    fail(new BuildThreadError({ message: messageOf(event, 'The build thread did not load') }))
  const onMessageError = () =>
    fail(new BuildThreadError({ message: "The page could not read the build thread's answer" }))
  worker.addEventListener('error', onError)
  worker.addEventListener('messageerror', onMessageError)
  return () => {
    worker.removeEventListener('error', onError)
    worker.removeEventListener('messageerror', onMessageError)
  }
}

const watchProcessor = (node: AudioWorkletNode, fail: (error: ProcessorError) => void) => {
  // Chrome tells what was thrown; a browser that doesn't still says the processor stopped. Chrome 156 calls only this
  // handler: listeners added for the event never hear it.
  node.onprocessorerror = (event) => fail(new ProcessorError({ message: messageOf(event, 'The processor threw') }))
  return () => {
    node.onprocessorerror = null
  }
}

const stopProcessor: StopProcessor = { _tag: 'Stop' }

/** Runs while the scope is open; returns the worker and the address of the engine it made. */
const spawnBuildThread = Effect.fn('spawnBuildThread')(function* (start: BuildThreadStart) {
  const { target: worker, failure } = yield* acquireWatched({
    make: () => new Worker(buildThreadUrl, { type: 'module', name: 'escapement-build' }),
    watch: watchBuildThread,
    release: (worker) => Effect.sync(() => worker.terminate())
  })
  const ready = Effect.callback<BuildThreadReady>((resume) => {
    // Its first message.
    const onMessage = (event: MessageEvent<BuildThreadReady>) => resume(Effect.succeed(event.data))
    worker.addEventListener('message', onMessage, { once: true })
    worker.postMessage(start)
    return Effect.sync(() => worker.removeEventListener('message', onMessage))
  })
  const { engine } = yield* Effect.raceFirst(ready, failure).pipe(
    Effect.mapError((cause) => new EngineStartError({ cause }))
  )
  return { worker, engine, failure }
})

/** Connected to the output while the scope is open, and stopped when it closes. */
export const startEngine = Effect.fn('startEngine')(function* (context: BaseAudioContext, module: WebAssembly.Module) {
  yield* Effect.tryPromise({
    try: () => context.audioWorklet.addModule(processorUrl),
    catch: (cause) => new EngineStartError({ cause })
  })
  // Shared memory exists only on cross-origin isolated pages.
  const [memory, commandRing, eventRing, telemetryBoard, loadClock] = yield* Effect.try({
    try: () =>
      [
        createEngineMemory(),
        createCommandRing(),
        createEventRing(),
        createTelemetryBoard(),
        createLoadClock()
      ] as const,
    catch: (cause) => new EngineStartError({ cause })
  })
  const messages = messageWriter(commandRing)
  const write = transactionWriter(messages)
  // The build thread is the first on the memory, so it goes before the processor.
  const buildThread = yield* spawnBuildThread({ module, memory, sampleRate: context.sampleRate })
  const processorOptions: EngineProcessorOptions = {
    module,
    memory,
    engine: buildThread.engine,
    commandRing,
    eventRing,
    telemetryBoard,
    loadClock
  }
  const audioThreadAlive = yield* Ref.make(true)
  const processor = yield* acquireWatched({
    make: () => {
      const node = new AudioWorkletNode(context, processorName, {
        outputChannelCount: [channelCount],
        processorOptions
      })
      node.connect(context.destination)
      return node
    },
    watch: watchProcessor,
    // A hung audio thread holds the context's lock, and the page would wait for it.
    release: (node) =>
      Effect.sync(() => {
        node.port.postMessage(stopProcessor)
        node.disconnect()
      }).pipe(Effect.when(Ref.get(audioThreadAlive)), Effect.asVoid)
  })
  const sounds = yield* sampleStore(buildThread.worker, buildThread.failure)
  const readTelemetry = telemetryReader(telemetryBoard)
  const threads: { readonly [Thread in EngineThread]: Answering } = {
    audio: processor.target.port,
    build: buildThread.worker
  }
  const started: Engine = {
    node: processor.target,
    send: transactionSender(write, (batch) => buildThread.worker.postMessage(batch, [batch.bytes.buffer])),
    events: yield* eventStream(eventRing),
    readTelemetry,
    loadClock,
    failure: Effect.raceAllFirst([processor.failure, buildThread.failure, lostStream(readTelemetry)]),
    storeSample: sounds.store,
    evictSample: sounds.evict,
    ping: (thread) => answered(threads[thread]),
    abandon: Ref.set(audioThreadAlive, false),
    breakStream: () => breakStream(messages)
  }
  return started
})

export const workletInfo = (node: AudioWorkletNode): Effect.Effect<WorkletInfo> =>
  Effect.callback<WorkletInfo>((resume) => {
    const onMessage = (event: MessageEvent<WorkletInfo>) => resume(Effect.succeed(event.data))
    node.port.addEventListener('message', onMessage, { once: true })
    node.port.start()
    return Effect.sync(() => node.port.removeEventListener('message', onMessage))
  })
