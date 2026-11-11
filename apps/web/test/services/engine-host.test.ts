import type { SoundLibrary } from '@escapement/compiler'
import { EngineLoadError, EngineStartError, LoadClockError, loadClockViews, measuringWord } from '@escapement/engine'
import {
  kick,
  kickSound,
  module,
  pageEngine,
  sampleRate,
  startEngine,
  type TestEngine
} from '@escapement/engine/testing'
import { plugins, Tick } from '@escapement/engine-description'
import {
  addClip,
  addNote,
  addTrack,
  createProject,
  defaultNote,
  HoldTarget,
  holding,
  newWriter,
  noHolds,
  stepTicks
} from '@escapement/model'
import { Boolean, Cause, Effect, Fiber, Layer, Option } from 'effect'
import { Digest } from 'effect/crypto'
import { FetchHttpClient } from 'effect/http'
import { Atom, AtomRegistry } from 'effect/reactivity'
import { TestClock } from 'effect/testing'
import { expect, test } from 'vitest'
import * as Y from 'yjs'
import { AudioOutput, type OutputContext } from '../../src/services/audio-output'
import {
  EngineHost,
  EngineModule,
  EngineState,
  engineHostLayer,
  LoadState,
  type Restarts
} from '../../src/services/engine-host'
import { LoadClocks } from '../../src/services/load-clocks'
import { preferencesLayer } from '../../src/services/preferences'
import { CannotReopen, PageReopen, type Taken } from '../../src/services/reopen'
import { ProjectSession, sessionOf } from '../../src/services/session'
import { KeptViews } from '../../src/services/view-store'
import { savedIn } from '../saved-in'

/**
 * Asleep until the test wakes it, as a browser keeps a context until the page is clicked, unless it runs from the start;
 * one that never wakes refuses to resume.
 */
const sleepingContext = (wakes: boolean, running: boolean) => {
  const woken = Promise.withResolvers<void>()
  const resumes = { count: 0 }
  const context = Object.assign(new EventTarget(), {
    state: Boolean.match(running, {
      onTrue: (): AudioContextState => 'running',
      onFalse: (): AudioContextState => 'suspended'
    }),
    sampleRate,
    currentTime: 0,
    // Nothing comes out of it: no playhead.
    getOutputTimestamp: (): AudioTimestamp => ({}),
    resume: () => {
      resumes.count++
      return Boolean.match(wakes, {
        onTrue: () => woken.promise,
        onFalse: () => Promise.reject(new DOMException('The audio device could not start', 'InvalidStateError'))
      })
    }
  })
  const wake = () => {
    context.state = 'running'
    woken.resolve()
    context.dispatchEvent(new Event('statechange'))
  }
  /** The device lets the context go, as when it is unplugged. */
  const interrupt = () => {
    context.state = 'suspended'
    context.dispatchEvent(new Event('statechange'))
  }
  return { context: context satisfies OutputContext, wake, interrupt, resumes: () => resumes.count }
}

/** The one sound the project names. */
const library: SoundLibrary = {
  load: (hash) =>
    Option.liftPredicate(hash, (hash) => hash === kick).pipe(
      Option.map(() => Effect.sync(() => ({ sampleRate, channels: [kickSound()] })))
    ),
  show: () => Effect.void
}

/** An engine the host started; the test plays its blocks, as a worklet would. */
interface Started {
  readonly engine: TestEngine
  readonly settle: () => void
  /** The left channel; silence once the audio thread is dead or hung. */
  readonly blocks: (count: number) => Float32Array
  /** Whether the host let go of the audio thread, so that nothing touches the context. */
  readonly abandoned: () => boolean
}

interface Hosting {
  readonly host: EngineHost
  readonly session: ProjectSession
  readonly registry: AtomRegistry.AtomRegistry
  readonly wake: () => void
  /** In the order the host started them. */
  readonly started: ReadonlyArray<Started>
  /** Every start the host tried, the ones that failed too. */
  readonly starts: () => number
  /** Times the page asked the context to resume. */
  readonly resumes: () => number
  /** What the page took along each time it left to reopen. */
  readonly reopens: ReadonlyArray<Taken>
  /** The page misses the audio thread's next answers, as when its main thread stalls or the computer sleeps. */
  readonly missAnswers: (count: number) => void
  /** The load clock's threads: how many the host started, and how many run now. */
  readonly clockThreads: { readonly started: number; readonly running: number }
  /** Whether the page is in sight. */
  readonly seen: Atom.Writable<boolean>
  readonly interrupt: () => void
}

interface Options {
  /** Whether Play can wake the context. */
  readonly wakes?: boolean
  /** Whether the host's start of that number, from 1, succeeds. */
  readonly starts?: (attempt: number) => boolean
  /** Whether the context runs from the start, as after a click on the page before. */
  readonly running?: boolean
  /** What the page took along, if it has just reopened. */
  readonly taken?: Taken
  /** Whether the tab keeps what the page takes along when it leaves to reopen. */
  readonly keeps?: boolean
  /** Whether the host's start of that number, from 1, never ends, as when the build thread hangs on its first batch. */
  readonly startHangs?: (attempt: number) => boolean
  /** Whether the engine's module loads. */
  readonly loads?: boolean
  /** The computer's logical cores. */
  readonly cores?: number
  /** Whether the load clock's thread fails as it starts. */
  readonly clockFails?: boolean
}

/**
 * The host of a project with the kick on its first step, on a context the test wakes, while `use` runs; time stands
 * until the test moves it.
 */
const hosted = (
  use: (hosting: Hosting) => Effect.Effect<void>,
  {
    wakes = true,
    starts = () => true,
    running = false,
    taken,
    keeps = true,
    startHangs = () => false,
    loads = true,
    cores = 8,
    clockFails = false
  }: Options = {}
) => {
  const doc = new Y.Doc()
  const by = newWriter('test')
  createProject(doc, by)
  // A kick from the start, its track's clip a bar long.
  Option.map(addTrack(doc, by, { plugin: plugins.sampler, sounds: { sample: kick } }), (track) =>
    Option.map(addClip(doc, by, { track, tick: Tick(0) }), (clip) =>
      addNote(doc, by, clip, { tick: Tick(0), key: defaultNote.key, length: defaultNote.length })
    )
  )
  // The filter on the master, for Load to turn, as no operation puts an effect anywhere yet.
  doc.transact(() =>
    doc.getMap('master').set(
      'slots',
      new Y.Map<unknown>([
        [
          'filter',
          new Y.Map<unknown>(
            Object.entries({
              plugin: { id: plugins.filter.id, version: plugins.filter.version },
              params: new Y.Map(),
              order: 'a0',
              deleted: false
            })
          )
        ]
      ])
    )
  )
  const { context, wake, interrupt, resumes } = sleepingContext(wakes, running)
  const started: Array<Started> = []
  const tried = { count: 0 }
  const reopens: Array<Taken> = []
  const page = { missed: 0 }
  const clockThreads = { started: 0, running: 0 }
  const seen = Atom.make(true)
  const clocks: LoadClocks = {
    cores,
    thread: () =>
      Effect.acquireRelease(
        Effect.sync(() => {
          clockThreads.started++
          clockThreads.running++
        }),
        () =>
          Effect.sync(() => {
            clockThreads.running--
          })
      ).pipe(
        Effect.andThen(
          Boolean.match(clockFails, {
            onTrue: () => Effect.fail(new LoadClockError({ cause: new Error('Not found') })),
            onFalse: () => Effect.never
          })
        ),
        Effect.scoped
      ),
    seen
  }
  const output: AudioOutput = {
    context,
    startEngine: () =>
      Effect.gen(function* () {
        tried.count++
        yield* Effect.when(
          Effect.failSync(() => new EngineStartError({ cause: new Error('No shared memory') })),
          Effect.sync(() => !starts(tried.count))
        )
        yield* Effect.when(
          Effect.never,
          Effect.sync(() => startHangs(tried.count))
        )
        const engine = startEngine({ initial: {} })
        const held = yield* pageEngine(engine)
        started.push({ engine, settle: held.settle, blocks: held.blocks, abandoned: held.abandoned })
        return {
          ...held.engine,
          ping: (thread) =>
            Effect.suspend(() =>
              Boolean.match(thread !== 'audio' || page.missed === 0, {
                onTrue: () => held.engine.ping(thread),
                onFalse: () => {
                  page.missed--
                  return Effect.never
                }
              })
            )
        }
      }),
    library: () => library
  }
  const layer = engineHostLayer.pipe(
    Layer.provideMerge(Layer.effect(ProjectSession, sessionOf(savedIn(doc), newWriter('page')))),
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(AudioOutput, output),
        Layer.succeed(LoadClocks, clocks),
        // Kept for the page alone: a new browser's.
        preferencesLayer.pipe(Layer.provide(Layer.succeed(KeptViews, Option.none()))),
        Layer.succeed(EngineModule, {
          module: Boolean.match(loads, {
            onTrue: () => Effect.succeed(module),
            onFalse: () => Effect.fail(new EngineLoadError({ cause: new Error('Not found') }))
          })
        }),
        Layer.succeed(PageReopen, {
          taken: Option.fromNullishOr(taken),
          reopen: (kept) =>
            Boolean.match(keeps, {
              onTrue: () => Effect.sync(() => void reopens.push(kept)),
              onFalse: () =>
                Effect.fail(new CannotReopen({ cause: new DOMException('Access is denied', 'SecurityError') }))
            }),
          reopening: () => false
        })
      )
    ),
    Layer.provideMerge(TestClock.layer()),
    // Benchmark's sounds come over the network; these tests play no Benchmark.
    Layer.provideMerge(Layer.mergeAll(FetchHttpClient.layer, Digest.layerWebCrypto))
  )
  return Effect.gen(function* () {
    const registry = yield* AtomRegistry.AtomRegistry
    yield* use({
      host: yield* EngineHost,
      session: yield* ProjectSession,
      registry,
      wake,
      started,
      starts: () => tried.count,
      resumes,
      reopens,
      missAnswers: (count) => {
        page.missed = count
      },
      clockThreads,
      seen,
      interrupt
    })
  }).pipe(Effect.provide(layer), Effect.provideService(AtomRegistry.AtomRegistry, AtomRegistry.make()))
}

const hosting = (...args: Parameters<typeof hosted>) => Effect.runPromise(hosted(...args))

/** Lets the host's fibers run until `done`. */
const until = (done: () => boolean) =>
  Effect.sync(done).pipe(
    // A turn each time it isn't, a thousand at most.
    Effect.tap((isDone) => Effect.when(Effect.yieldNow, Effect.succeed(!isDone))),
    Effect.repeat({ until: (isDone) => isDone, times: 999 }),
    Effect.andThen(Effect.sync(() => expect(done()).toBe(true)))
  )

const loudest = (samples: Float32Array) => samples.reduce((loudest, sample) => Math.max(loudest, Math.abs(sample)), 0)

/** The newest engine the host started, once it is ready. */
const ready = ({ host, registry, started }: Hosting, count: number) =>
  until(() => started.length === count && registry.get(host.state)._tag === 'Ready').pipe(
    Effect.map(() => started[count - 1])
  )

/** Plays the arrangement on the first engine, once it is ready. */
const playing = (hosting: Hosting) =>
  Effect.gen(function* () {
    const first = yield* ready(hosting, 1)
    const pressed = yield* Effect.forkChild(hosting.host.togglePlay)
    hosting.wake()
    yield* Fiber.join(pressed)
    first.settle()
    return first
  })

/** The error of a failure, by its kind and what it carries; a bug's own. */
const errorOf = <E>(cause: Cause.Cause<E>) => Option.getOrElse(Cause.findErrorOption(cause), () => Cause.squash(cause))

/** The engine's state, with the error it failed or hung by. */
const seenState = (state: EngineState) =>
  EngineState.$match(state, {
    Starting: ({ afterFailure }) => ({ _tag: 'Starting', afterFailure }),
    Ready: () => ({ _tag: 'Ready' }),
    Failed: ({ cause, gaveUp }) => ({ _tag: 'Failed', error: errorOf(cause), gaveUp }),
    Hung: ({ error }) => ({ _tag: 'Hung', error })
  })

/** The restarts, with the error of the last failure. */
const seenRestarts = ({ count, last }: Restarts) => ({
  count,
  last: Option.getOrUndefined(Option.map(last, errorOf))
})

/** An error as the engine reports one, by its kind and message. */
const reported = (_tag: string, message: unknown) => expect.objectContaining({ _tag, message })

/** What a panic says, where. */
const panicError = (thread: 'Processor' | 'BuildThread', message: string) =>
  reported(
    `${thread}Error`,
    expect.stringMatching(
      new RegExp(`^Uncaught Error: panicked at crates/engine-core/src/[\\w/]+\\.rs:\\d+:\\d+: ${message}$`)
    )
  )

/** A start that failed, by what went wrong. */
const startError = (cause: unknown) => expect.objectContaining({ _tag: 'EngineStartError', cause })

/** The audio thread panics in its next block, and the host makes engine number `next`. */
const panicked = (hosting: Hosting, engine: Started, next: number) =>
  Effect.gen(function* () {
    yield* hosting.host.panicAudio
    engine.blocks(1)
    return yield* ready(hosting, next)
  })

/** Whether an engine plays the arrangement: its first step, from the loop's start. */
const playsFromTheStart = (engine: Started) => {
  engine.settle()
  const heard = engine.blocks(1)
  expect(engine.engine.readTelemetry()).toMatchObject({ playing: true })
  expect(engine.engine.readTelemetry()?.position).toBeLessThan(stepTicks)
  expect(loudest(heard)).toBeGreaterThan(0)
}

/** About a bar at the slice's tempo: the kick on its first step sounds once in it. */
const bar = Math.ceil((2.1 * sampleRate) / 128)

/** The board after the engine takes what the page sent and plays a block. */
const board = (engine: Started) => {
  engine.settle()
  engine.blocks(1)
  return engine.engine.readTelemetry()
}

test('Play pressed while it plays pauses it where it is, and pressed again plays on from there', () =>
  hosting((hosting) =>
    Effect.gen(function* () {
      const { host, registry } = hosting
      const first = yield* playing(hosting)
      first.blocks(100)
      yield* host.togglePlay
      expect(registry.get(host.transport)).toBe('stopped')
      const paused = board(first)
      expect(paused).toMatchObject({ playing: false })
      expect(paused?.position).toBeGreaterThan(stepTicks)
      first.blocks(100)
      expect(first.engine.readTelemetry()).toMatchObject({ playing: false, position: paused?.position })
      yield* host.togglePlay
      expect(registry.get(host.transport)).toBe('playing')
      expect(board(first)).toMatchObject({ playing: true, position: paused?.position })
    })
  ))

test('To start takes it back to the start, playing on if it plays; Stop stops it there at once', () =>
  hosting((hosting) =>
    Effect.gen(function* () {
      const { host, registry } = hosting
      const first = yield* playing(hosting)
      first.blocks(100)
      yield* host.toStart
      expect(registry.get(host.transport)).toBe('playing')
      playsFromTheStart(first)
      first.blocks(100)
      yield* host.stop
      expect(registry.get(host.transport)).toBe('stopped')
      expect(board(first)).toMatchObject({ playing: false, position: 0 })
      // Stopped, To start leaves it there; paused, it takes it back too.
      yield* host.toStart
      expect(board(first)).toMatchObject({ playing: false, position: 0 })
      yield* host.togglePlay
      playsFromTheStart(first)
      first.blocks(100)
      yield* host.togglePlay
      yield* host.toStart
      expect(board(first)).toMatchObject({ playing: false, position: 0 })
      yield* host.togglePlay
      playsFromTheStart(first)
    })
  ))

/** Whether the engine's clock runs its bursts, as the host set it. */
const bursting = (engine: Started) => Atomics.load(loadClockViews(engine.engine.loadClock), measuringWord) === 1

test("the DSP load is measured while it plays in sight, its clock's thread kept while measuring may go on; switched off, the thread goes", () =>
  hosting((hosting) =>
    Effect.gen(function* () {
      const { host, registry, clockThreads, seen } = hosting
      const first = yield* ready(hosting, 1)
      expect([registry.get(host.measuring), clockThreads, bursting(first)]).toEqual([
        'waiting',
        { started: 1, running: 1 },
        false
      ])
      yield* playing(hosting)
      expect([registry.get(host.measuring), bursting(first)]).toEqual(['on', true])
      registry.set(seen, false)
      expect([registry.get(host.measuring), bursting(first)]).toEqual(['waiting', false])
      registry.set(seen, true)
      // Its context let go, the sound stands though Play is on.
      hosting.interrupt()
      expect([registry.get(host.measuring), bursting(first)]).toEqual(['waiting', false])
      hosting.wake()
      expect(registry.get(host.measuring)).toBe('on')
      yield* host.toggleMeasuring
      yield* until(() => clockThreads.running === 0)
      expect([registry.get(host.measuring), bursting(first)]).toEqual(['off', false])
      yield* host.toggleMeasuring
      yield* until(() => clockThreads.running === 1)
      expect([registry.get(host.measuring), clockThreads.started, bursting(first)]).toEqual(['on', 2, true])
      // A new engine, a thread of its own; the old one's goes with it.
      yield* host.restart
      const second = yield* ready(hosting, 2)
      yield* until(() => clockThreads.started === 3 && clockThreads.running === 1)
      expect(bursting(second)).toBe(true)
    })
  ))

test("a load clock's thread that fails leaves the engine playing, the load unmeasured", () =>
  hosting(
    (hosting) =>
      Effect.gen(function* () {
        const { host, registry, clockThreads } = hosting
        const first = yield* playing(hosting)
        // Tried again as measuring changes, waiting and then on, and failing each time.
        yield* until(() => clockThreads.started === 2 && clockThreads.running === 0)
        expect([registry.get(host.state)._tag, registry.get(host.measuring), host.frame()?.dspLoad]).toEqual([
          'Ready',
          'on',
          undefined
        ])
        playsFromTheStart(first)
      }),
    { clockFails: true }
  ))

test('on 4 cores or fewer the DSP load is never measured, and switching it does nothing', () =>
  hosting(
    (hosting) =>
      Effect.gen(function* () {
        const { host, registry, clockThreads } = hosting
        yield* playing(hosting)
        yield* host.toggleMeasuring
        expect([registry.get(host.measuring), clockThreads.started]).toEqual(['few-cores', 0])
      }),
    { cores: 4 }
  ))

test("another tab's hold plays over the document, as this page's own does, until it lets go", () =>
  hosting((hosting) =>
    Effect.gen(function* () {
      const { registry, session } = hosting
      const first = yield* playing(hosting)
      expect(loudest(first.blocks(bar))).toBeGreaterThan(0)
      const volume = HoldTarget.TrackStrip({
        track: Option.getOrThrow(Option.fromUndefinedOr(registry.get(session.project.trackIds)[0])),
        param: 'volume'
      })
      registry.set(session.heldElsewhere, holding(noHolds, volume, 0))
      // Past the hit that sounds as the hold comes, and its ramp.
      first.blocks(bar)
      expect(loudest(first.blocks(bar))).toBe(0)
      registry.set(session.heldElsewhere, noHolds)
      first.blocks(1)
      expect(loudest(first.blocks(bar))).toBeGreaterThan(0)
    })
  ))

test("a restart while playing makes a new engine on the same context, which plays on from the loop's start", () =>
  hosting((hosting) =>
    Effect.gen(function* () {
      const { host, registry } = hosting
      const first = yield* playing(hosting)
      expect(loudest(first.blocks(100))).toBeGreaterThan(0.001)
      expect(first.engine.readTelemetry()?.position).toBeGreaterThan(stepTicks)

      yield* host.restart
      const second = yield* ready(hosting, 2)
      playsFromTheStart(second)
      expect(registry.get(host.transport)).toBe('playing')
      expect(registry.get(host.restarts).count).toBe(0)
      // The page's buttons reach the new engine: the old one, stopping, left it in place.
      yield* panicked(hosting, second, 3)
    })
  ))

test('a restart while Play wakes the sound leaves the new engine playing once the context runs', () =>
  hosting((hosting) =>
    Effect.gen(function* () {
      const { host, registry, wake } = hosting
      yield* ready(hosting, 1)
      const pressed = yield* Effect.forkChild(host.togglePlay, { startImmediately: true })
      yield* host.restart
      const second = yield* ready(hosting, 2)
      wake()
      yield* Fiber.join(pressed)
      second.settle()
      expect(loudest(second.blocks(10))).toBeGreaterThan(0)
      expect(second.engine.readTelemetry()).toMatchObject({ playing: true })
      expect(registry.get(host.transport)).toBe('playing')
    })
  ))

test('Play waits while the sound wakes: a second press starts nothing, and the arrangement plays once it runs', () =>
  hosting((hosting) =>
    Effect.gen(function* () {
      const { host, registry, wake, resumes } = hosting
      const first = yield* ready(hosting, 1)
      const pressed = yield* Effect.forkChild(host.togglePlay, { startImmediately: true })
      expect(registry.get(host.transport)).toBe('starting')
      const again = yield* Effect.forkChild(host.togglePlay, { startImmediately: true })
      expect(resumes()).toBe(1)
      // Over at once, waiting for nothing.
      expect(again.pollUnsafe()).toBeDefined()
      expect(registry.get(host.transport)).toBe('starting')
      wake()
      yield* Fiber.join(pressed)
      first.settle()
      expect(registry.get(host.transport)).toBe('playing')
      expect(loudest(first.blocks(10))).toBeGreaterThan(0)
      expect(first.engine.readTelemetry()).toMatchObject({ playing: true })
    })
  ))

test('a press of Play interrupted while the sound wakes leaves the arrangement stopped', () =>
  hosting((hosting) =>
    Effect.gen(function* () {
      const { host, registry } = hosting
      yield* ready(hosting, 1)
      const pressed = yield* Effect.forkChild(host.togglePlay, { startImmediately: true })
      expect(registry.get(host.transport)).toBe('starting')
      yield* Fiber.interrupt(pressed)
      expect(registry.get(host.transport)).toBe('stopped')
    })
  ))

test('a give-up while Play wakes the sound leaves the arrangement stopped, and Play then does nothing', () =>
  hosting((hosting) =>
    Effect.gen(function* () {
      const { host, registry, wake } = hosting
      const first = yield* ready(hosting, 1)
      const pressed = yield* Effect.forkChild(host.togglePlay, { startImmediately: true })
      const second = yield* panicked(hosting, first, 2)
      const third = yield* panicked(hosting, second, 3)
      yield* host.panicAudio
      third.blocks(1)
      yield* until(() => registry.get(host.state)._tag === 'Failed')
      expect(registry.get(host.transport)).toBe('stopped')
      wake()
      yield* Fiber.join(pressed)
      expect(registry.get(host.transport)).toBe('stopped')
      yield* host.togglePlay
      expect(registry.get(host.transport)).toBe('stopped')
    })
  ))

test("a panic of the audio thread: the watchdog makes a new engine, which plays on from the loop's start", () =>
  hosting((hosting) =>
    Effect.gen(function* () {
      const { host, registry } = hosting
      const first = yield* playing(hosting)
      first.blocks(100)
      playsFromTheStart(yield* panicked(hosting, first, 2))
      expect(registry.get(host.transport)).toBe('playing')
      expect(seenRestarts(registry.get(host.restarts))).toEqual({
        count: 1,
        last: panicError('Processor', 'PanicAudio 1')
      })
    })
  ))

test('after a panic, the page shows how long from learning of it until the new engine plays', () =>
  hosting((hosting) =>
    Effect.gen(function* () {
      const { host, registry } = hosting
      const first = yield* playing(hosting)
      const second = yield* panicked(hosting, first, 2)
      // Not until it plays.
      yield* TestClock.adjust('10 millis')
      expect(registry.get(host.restarts).backInMs).toEqual(Option.none())
      playsFromTheStart(second)
      yield* TestClock.adjust('2 millis')
      yield* until(() => Option.isSome(registry.get(host.restarts).backInMs))
      expect(registry.get(host.restarts).backInMs).toEqual(Option.some(12))
      // The next failure takes it away: the sound is gone again.
      yield* panicked(hosting, second, 3)
      expect(registry.get(host.restarts).backInMs).toEqual(Option.none())
    })
  ))

test('the time back counts from the first failure, however many new engines fail to start after it', () =>
  hosting(
    (hosting) =>
      Effect.gen(function* () {
        const { host, registry } = hosting
        const first = yield* playing(hosting)
        yield* host.panicAudio
        first.blocks(1)
        yield* until(() => hosting.starts() === 2)
        yield* TestClock.adjust('10 seconds')
        const third = yield* ready(hosting, 2)
        playsFromTheStart(third)
        yield* TestClock.adjust('4 millis')
        yield* until(() => Option.isSome(registry.get(host.restarts).backInMs))
        expect(registry.get(host.restarts)).toMatchObject({ count: 2, backInMs: Option.some(10_004) })
      }),
    { startHangs: (attempt) => attempt === 2 }
  ))

test('a failure while the arrangement is stopped shows no time back: no sound went', () =>
  hosting((hosting) =>
    Effect.gen(function* () {
      const { host, registry } = hosting
      const first = yield* ready(hosting, 1)
      hosting.wake()
      yield* host.panicAudio
      first.blocks(1)
      first.settle()
      const second = yield* ready(hosting, 2)
      second.settle()
      second.blocks(1)
      yield* TestClock.adjust('1 second')
      expect(registry.get(host.restarts).count).toBe(1)
      expect(registry.get(host.restarts).backInMs).toEqual(Option.none())
    })
  ))

test('a restart the page asked for, not a failure, shows no time back', () =>
  hosting((hosting) =>
    Effect.gen(function* () {
      const { host, registry } = hosting
      yield* playing(hosting)
      yield* host.restart
      playsFromTheStart(yield* ready(hosting, 2))
      yield* TestClock.adjust('1 second')
      expect(registry.get(host.restarts)).toEqual({ count: 0, last: Option.none(), backInMs: Option.none() })
    })
  ))

test('a panic of the build thread: the watchdog makes a new engine, which plays on', () =>
  hosting((hosting) =>
    Effect.gen(function* () {
      const { host, registry } = hosting
      yield* playing(hosting)
      yield* host.panicBuild
      playsFromTheStart(yield* ready(hosting, 2))
      expect(seenRestarts(registry.get(host.restarts))).toEqual({
        count: 1,
        last: panicError('BuildThread', 'PanicBuild 1')
      })
    })
  ))

test('on the third failure within a minute the watchdog gives up and the arrangement stops; a restart counts afresh', () =>
  hosting((hosting) =>
    Effect.gen(function* () {
      const { host, registry } = hosting
      const first = yield* playing(hosting)
      const second = yield* panicked(hosting, first, 2)
      yield* TestClock.adjust('30 seconds')
      const third = yield* panicked(hosting, second, 3)
      playsFromTheStart(third)
      yield* TestClock.adjust('29 seconds')
      expect(registry.get(host.restarts).backInMs).toEqual(Option.some(expect.any(Number)))
      yield* host.panicAudio
      third.blocks(1)
      yield* until(() => registry.get(host.state)._tag === 'Failed')
      expect(seenState(registry.get(host.state))).toEqual({
        _tag: 'Failed',
        error: panicError('Processor', 'PanicAudio 3'),
        gaveUp: 'often'
      })
      expect(registry.get(host.transport)).toBe('stopped')
      // Gone again, and not coming back.
      expect(registry.get(host.restarts)).toMatchObject({ count: 2 })
      expect(registry.get(host.restarts).backInMs).toEqual(Option.none())
      expect(hosting.started).toHaveLength(3)

      yield* host.restart
      const fourth = yield* ready(hosting, 4)
      fourth.settle()
      fourth.blocks(1)
      expect(fourth.engine.readTelemetry()).toMatchObject({ playing: false })
      yield* panicked(hosting, fourth, 5)
      expect(registry.get(host.restarts).count).toBe(3)
    })
  ))

test('failures more than a minute apart never add up to giving up', () =>
  hosting((hosting) =>
    Effect.gen(function* () {
      const { host, registry } = hosting
      const first = yield* playing(hosting)
      const second = yield* panicked(hosting, first, 2)
      yield* TestClock.adjust('30 seconds')
      const third = yield* panicked(hosting, second, 3)
      yield* TestClock.adjust('31 seconds')
      playsFromTheStart(yield* panicked(hosting, third, 4))
      expect(registry.get(host.restarts).count).toBe(3)
    })
  ))

test("a failed engine's events stay on the list, and the next engine's are numbered on", () =>
  hosting((hosting) =>
    Effect.gen(function* () {
      const { host, registry } = hosting
      /** The engine refuses both, and the page reads its events. */
      const refused = (engine: Started, count: number) =>
        Effect.gen(function* () {
          yield* host.sendBadCommand
          engine.blocks(1)
          yield* TestClock.adjust('1 second')
          yield* until(() => registry.get(host.events).length === count)
        })
      const first = yield* playing(hosting)
      yield* refused(first, 2)
      const before = registry.get(host.events)
      const second = yield* panicked(hosting, first, 2)
      yield* refused(second, 4)
      expect(registry.get(host.events).slice(2)).toEqual(before)
      expect(registry.get(host.events).map(({ number }) => number)).toEqual([4, 3, 2, 1])
    })
  ))

test('a new engine that fails to start in place of a failed one is one more failure, not the end', () =>
  hosting(
    (hosting) =>
      Effect.gen(function* () {
        const { host, registry } = hosting
        const first = yield* playing(hosting)
        playsFromTheStart(yield* panicked(hosting, first, 2))
        expect(hosting.starts()).toBe(3)
        expect(seenRestarts(registry.get(host.restarts))).toEqual({
          count: 2,
          last: startError(expect.objectContaining({ message: 'No shared memory' }))
        })
      }),
    { starts: (attempt) => attempt !== 2 }
  ))

test("an engine that can't start isn't tried again", () =>
  hosting(
    (hosting) =>
      Effect.gen(function* () {
        const { host, registry } = hosting
        yield* until(() => registry.get(host.state)._tag === 'Failed')
        expect(seenState(registry.get(host.state))).toEqual({
          _tag: 'Failed',
          error: startError(expect.objectContaining({ message: 'No shared memory' })),
          gaveUp: 'start'
        })
        yield* Effect.yieldNow
        expect(hosting.starts()).toBe(1)
        expect(registry.get(host.restarts).count).toBe(0)
      }),
    { starts: () => false }
  ))

test("Play on a context that won't wake leaves the arrangement stopped", () =>
  hosting(
    (hosting) =>
      Effect.gen(function* () {
        const { host, registry } = hosting
        yield* ready(hosting, 1)
        expect((yield* Effect.exit(host.togglePlay))._tag).toBe('Failure')
        expect(registry.get(host.transport)).toBe('stopped')
      }),
    { wakes: false }
  ))

const streamLostError = reported('CommandStreamError', 'The engine lost its command stream')

/** The engine loses its command stream in its next block, and the host makes engine number `next` once it reads why. */
const streamLost = (hosting: Hosting, engine: Started, next: number) =>
  Effect.gen(function* () {
    yield* hosting.host.breakStream
    engine.blocks(1)
    yield* TestClock.adjust('1 second')
    return yield* ready(hosting, next)
  })

test("a lost command stream: the watchdog makes a new engine, which plays on and takes the page's edits again", () =>
  hosting((hosting) =>
    Effect.gen(function* () {
      const { host, registry } = hosting
      const first = yield* playing(hosting)
      first.blocks(100)
      const second = yield* streamLost(hosting, first, 2)
      playsFromTheStart(second)
      expect(seenRestarts(registry.get(host.restarts))).toEqual({ count: 1, last: streamLostError })
      yield* host.togglePlay
      second.blocks(1)
      expect(second.engine.readTelemetry()).toMatchObject({ playing: false })
    })
  ))

test('lost streams count with panics: the third failure within a minute gives up', () =>
  hosting((hosting) =>
    Effect.gen(function* () {
      const { host, registry } = hosting
      const first = yield* playing(hosting)
      const second = yield* panicked(hosting, first, 2)
      const third = yield* streamLost(hosting, second, 3)
      yield* host.breakStream
      third.blocks(1)
      yield* TestClock.adjust('1 second')
      yield* until(() => registry.get(host.state)._tag === 'Failed')
      expect(seenState(registry.get(host.state))).toEqual({ _tag: 'Failed', error: streamLostError, gaveUp: 'often' })
      expect(registry.get(host.transport)).toBe('stopped')
      expect(hosting.started).toHaveLength(3)
    })
  ))

test('a stream lost before the first Play takes Play with it, and the new engine plays', () =>
  hosting((hosting) =>
    Effect.gen(function* () {
      const { host, registry } = hosting
      const first = yield* ready(hosting, 1)
      yield* host.breakStream
      const pressed = yield* Effect.forkChild(host.togglePlay)
      hosting.wake()
      yield* Fiber.join(pressed)
      first.blocks(1)
      expect(first.engine.readTelemetry()).toMatchObject({ playing: false })
      yield* TestClock.adjust('1 second')
      playsFromTheStart(yield* ready(hosting, 2))
      expect(registry.get(host.transport)).toBe('playing')
    })
  ))

/** What a page reopened after a hang has from the one before; the test says when that one hung. */
const takenAfterHang = (hangs: ReadonlyArray<number>): Taken => ({
  hangs,
  playing: true,
  restarts: hangs.length,
  hang: 'The audio thread stopped answering'
})

const audioHung = reported('AudioThreadHung', 'The audio thread stopped answering')

/** The audio thread hangs, and the host notices: blocks stand a second, then two pings go unanswered. */
const hangAudio = (hosting: Hosting) =>
  Effect.gen(function* () {
    yield* hosting.host.hangAudio
    yield* TestClock.adjust('7 seconds')
    yield* until(() => hosting.registry.get(hosting.host.state)._tag === 'Hung')
  })

test('a hang of the audio thread while playing: the page lets the thread go and reopens, taking along that it played', () =>
  hosting((hosting) =>
    Effect.gen(function* () {
      const { host, registry, reopens } = hosting
      const first = yield* playing(hosting)
      first.blocks(10)
      const resumes = hosting.resumes()
      yield* hangAudio(hosting)
      expect(first.abandoned()).toBe(true)
      expect(reopens).toEqual([takenAfterHang([expect.any(Number)])])
      expect(seenState(registry.get(host.state))).toEqual({ _tag: 'Hung', error: audioHung })
      // Until the page is gone, nothing touches the context: Play doesn't wake it, Restart starts nothing on it.
      yield* host.togglePlay
      yield* host.togglePlay
      yield* host.restart
      yield* Effect.yieldNow
      expect(hosting.resumes()).toBe(resumes)
      expect(hosting.starts()).toBe(1)
    })
  ))

test('on the third hang within a minute the page stays, stopped, and Restart does nothing', () =>
  hosting(
    (hosting) =>
      Effect.gen(function* () {
        const { host, registry, reopens } = hosting
        // Played on without a click.
        const first = yield* ready(hosting, 1)
        expect(registry.get(host.transport)).toBe('playing')
        expect(seenRestarts(registry.get(host.restarts))).toEqual({ count: 2, last: audioHung })
        first.settle()
        first.blocks(10)
        yield* hangAudio(hosting)
        expect(first.abandoned()).toBe(true)
        expect(reopens).toEqual([])
        expect(registry.get(host.transport)).toBe('stopped')
        yield* host.restart
        yield* Effect.yieldNow
        expect(hosting.starts()).toBe(1)
      }),
    { running: true, taken: takenAfterHang([-50_000, -10_000]) }
  ))

test('hangs more than a minute apart never add up to staying', () =>
  hosting(
    (hosting) =>
      Effect.gen(function* () {
        const first = yield* ready(hosting, 1)
        first.settle()
        first.blocks(10)
        yield* hangAudio(hosting)
        expect(hosting.reopens).toEqual([{ ...takenAfterHang([expect.any(Number)]), restarts: 3 }])
      }),
    { running: true, taken: takenAfterHang([-58_000, -57_500]) }
  ))

test('a page reopened after a hang plays on if it played and its context runs; asleep, it waits for Play', () =>
  Effect.runPromise(
    Effect.andThen(
      hosted(
        (hosting) =>
          Effect.gen(function* () {
            playsFromTheStart(yield* ready(hosting, 1))
            expect(hosting.registry.get(hosting.host.transport)).toBe('playing')
          }),
        { running: true, taken: takenAfterHang([0]) }
      ),
      hosted(
        (hosting) =>
          Effect.gen(function* () {
            yield* ready(hosting, 1)
            expect(hosting.registry.get(hosting.host.transport)).toBe('stopped')
          }),
        { taken: takenAfterHang([0]) }
      )
    )
  ))

test('a hang of the build thread: the watchdog makes a new engine, which plays on', () =>
  hosting((hosting) =>
    Effect.gen(function* () {
      const { host, registry } = hosting
      const first = yield* playing(hosting)
      yield* host.hangBuild
      yield* TestClock.adjust('6 seconds')
      playsFromTheStart(yield* ready(hosting, 2))
      expect(first.abandoned()).toBe(false)
      expect(hosting.reopens).toEqual([])
      expect(seenRestarts(registry.get(host.restarts))).toEqual({
        count: 1,
        last: reported('BuildThreadHung', 'The build thread stopped answering')
      })
    })
  ))

test('no hang without both: blocks that stand while the thread answers, or answers the page misses while blocks go on', () =>
  hosting((hosting) =>
    Effect.gen(function* () {
      const { host, registry, reopens } = hosting
      // A device that stalls: the thread is there, but no block comes.
      yield* playing(hosting)
      yield* TestClock.adjust('10 seconds')
      // The page's main thread stalls: answers come late, while blocks go on.
      hosting.missAnswers(100)
      yield* Effect.replicateEffect(
        Effect.sync(() => hosting.started[0].blocks(10)).pipe(Effect.andThen(TestClock.adjust('1 second'))),
        10,
        { discard: true }
      )
      expect(registry.get(host.state)._tag).toBe('Ready')
      expect(reopens).toEqual([])
    })
  ))

test('a computer that wakes from sleep, its answer missed once while blocks stand, has no hang', () =>
  hosting((hosting) =>
    Effect.gen(function* () {
      const first = yield* playing(hosting)
      first.blocks(10)
      hosting.missAnswers(1)
      yield* TestClock.adjust('10 seconds')
      expect(hosting.registry.get(hosting.host.state)._tag).toBe('Ready')
      expect(hosting.reopens).toEqual([])
    })
  ))

test('Restart before the watchdog notices the audio thread hang does nothing, and the page reopens', () =>
  hosting((hosting) =>
    Effect.gen(function* () {
      const first = yield* playing(hosting)
      first.blocks(10)
      yield* hosting.host.hangAudio
      const restarting = yield* Effect.forkChild(hosting.host.restart, { startImmediately: true })
      yield* TestClock.adjust('7 seconds')
      yield* Fiber.join(restarting)
      yield* until(() => hosting.reopens.length === 1)
      expect(first.abandoned()).toBe(true)
      expect(hosting.starts()).toBe(1)
    })
  ))

test('an engine whose first start never ends is given up after ten seconds, with the reason', () =>
  hosting(
    (hosting) =>
      Effect.gen(function* () {
        yield* TestClock.adjust('10 seconds')
        yield* until(() => hosting.registry.get(hosting.host.state)._tag === 'Failed')
        expect(seenState(hosting.registry.get(hosting.host.state))).toEqual({
          _tag: 'Failed',
          error: startError(reported('BuildThreadHung', 'The build thread did not answer its start')),
          gaveUp: 'start'
        })
        expect(hosting.starts()).toBe(1)
      }),
    { startHangs: (attempt) => attempt === 1 }
  ))

test("a silent audio thread on a context that sleeps isn't hung until the context runs", () =>
  hosting((hosting) =>
    Effect.gen(function* () {
      const { host, registry, reopens } = hosting
      yield* ready(hosting, 1)
      yield* host.hangAudio
      yield* TestClock.adjust('10 seconds')
      expect(registry.get(host.state)._tag).toBe('Ready')
      const pressed = yield* Effect.forkChild(host.togglePlay)
      hosting.wake()
      yield* Fiber.join(pressed)
      yield* TestClock.adjust('7 seconds')
      yield* until(() => reopens.length === 1)
      expect(reopens[0]).toMatchObject({ playing: true })
    })
  ))

test("a page that can't take along how often it hung stays, stopped, rather than reopen without counting", () =>
  hosting(
    (hosting) =>
      Effect.gen(function* () {
        const first = yield* playing(hosting)
        first.blocks(10)
        yield* hangAudio(hosting)
        expect(hosting.registry.get(hosting.host.transport)).toBe('stopped')
        expect(hosting.registry.get(hosting.host.state)._tag).toBe('Hung')
      }),
    { keeps: false }
  ))

test('Load turns the filter 1000 times a second and rebuilds every second for ten seconds, then lets go: the document never changes and the engine refuses nothing', () =>
  hosting((hosting) =>
    Effect.gen(function* () {
      const { host, session, registry } = hosting
      const engine = yield* playing(hosting)
      const before = registry.get(session.project.master)
      const loading = yield* Effect.forkChild(host.runLoad)
      yield* until(() => registry.get(host.load)._tag === 'Running')
      // A second press meanwhile adds nothing.
      yield* host.runLoad
      yield* Effect.replicateEffect(
        TestClock.adjust('100 millis').pipe(
          Effect.andThen(
            Effect.sync(() => {
              engine.settle()
              engine.blocks(38)
            })
          )
        ),
        100,
        { discard: true }
      )
      yield* Fiber.join(loading)
      expect(registry.get(host.load)).toEqual(LoadState.Done({ moves: 10_000, rebuilds: 10, seconds: 10 }))
      expect(registry.get(session.holds)).toEqual(noHolds)
      expect(registry.get(session.project.master)).toEqual(before)
      expect(registry.get(host.events)).toEqual([])
      expect(engine.engine.readTelemetry()).toMatchObject({ epoch: 10, playing: true, lostNotes: 0 })
    })
  ))

test('Load does nothing while the engine sleeps until Play, and says why', () =>
  hosting((hosting) =>
    Effect.gen(function* () {
      const { host, session, registry } = hosting
      yield* ready(hosting, 1)
      yield* host.runLoad
      expect(registry.get(host.load)).toEqual(LoadState.Asleep())
      expect(registry.get(session.holds)).toEqual(noHolds)
    })
  ))

test('an engine started in place of one that failed says so; the first, and one a restart asks for, do not', () =>
  Effect.runPromise(
    Effect.all([
      hosted(
        (hosting) =>
          Effect.gen(function* () {
            yield* until(() => hosting.starts() === 1)
            expect(seenState(hosting.registry.get(hosting.host.state))).toEqual({
              _tag: 'Starting',
              afterFailure: false
            })
          }),
        { startHangs: (attempt) => attempt === 1 }
      ),
      hosted(
        (hosting) =>
          Effect.gen(function* () {
            const first = yield* playing(hosting)
            yield* hosting.host.panicAudio
            first.blocks(1)
            yield* until(() => hosting.starts() === 2)
            expect(seenState(hosting.registry.get(hosting.host.state))).toEqual({
              _tag: 'Starting',
              afterFailure: true
            })
          }),
        { startHangs: (attempt) => attempt === 2 }
      ),
      hosted(
        (hosting) =>
          Effect.gen(function* () {
            const first = yield* playing(hosting)
            yield* hosting.host.panicAudio
            first.blocks(1)
            yield* ready(hosting, 2)
            // After a failure, but asked for.
            yield* hosting.host.restart
            yield* until(() => hosting.starts() === 3)
            expect(seenState(hosting.registry.get(hosting.host.state))).toEqual({
              _tag: 'Starting',
              afterFailure: false
            })
          }),
        { startHangs: (attempt) => attempt === 3 }
      ),
      hosted(
        (hosting) =>
          Effect.gen(function* () {
            yield* until(() => hosting.starts() === 1)
            expect(seenState(hosting.registry.get(hosting.host.state))).toEqual({
              _tag: 'Starting',
              afterFailure: true
            })
          }),
        { taken: takenAfterHang([0]), startHangs: (attempt) => attempt === 1 }
      )
    ])
  ))

test("a module that doesn't load is given up on as such", () =>
  hosting(
    (hosting) =>
      Effect.gen(function* () {
        yield* until(() => hosting.registry.get(hosting.host.state)._tag === 'Failed')
        expect(seenState(hosting.registry.get(hosting.host.state))).toEqual({
          _tag: 'Failed',
          error: new EngineLoadError({ cause: new Error('Not found') }),
          gaveUp: 'load'
        })
        expect(hosting.starts()).toBe(0)
      }),
    { loads: false }
  ))
