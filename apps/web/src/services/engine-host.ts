import { type Compiler, compile, storeWithStatus } from '@escapement/compiler'
import {
  type BenchmarkResult,
  type BuildThreadError,
  benchmarkEngine,
  Command,
  compileEngine,
  DeviceEdit,
  type EngineEvent,
  type EngineFailure,
  type EngineLoadError,
  type EngineStartError,
  type Heard,
  heardTickReader,
  NodeHandle,
  type PlaybackStats,
  playbackStatsOf,
  type Send,
  type Telemetry,
  type Transaction
} from '@escapement/engine'
import { paramValue } from '@escapement/engine-description'
import { HoldTarget, holding, lettingGo } from '@escapement/model'
import {
  Array,
  Boolean,
  Cause,
  Clock,
  Context,
  Data,
  Duration,
  Effect,
  Exit,
  Fiber,
  FiberHandle,
  FiberSet,
  Layer,
  Match,
  Option,
  Ref,
  Schedule,
  Semaphore,
  Stream
} from 'effect'
import { Atom, AtomRegistry } from 'effect/reactivity'
import { AudioOutput, type OutputEngine } from './audio-output'
import { type BenchmarkSoundLost, benchmarkPlay } from './benchmark-project'
import { AudioThreadHung, answers, type BuildThreadHung, hangs, startInTime } from './hang-watch'
import { PageReopen } from './reopen'
import { badSample, manifestLines, type SampleLine, type ShowSample, sampleLoading, withStatus } from './samples'
import { ProjectSession } from './session'

/** How an engine's run fails, besides a bug. */
export type RunFailure = EngineStartError | EngineFailure | AudioThreadHung | BuildThreadHung

/** How Benchmark fails, besides a bug: the module, the engine, a sound, or a render that takes too long. */
export type BenchmarkFailure =
  | EngineLoadError
  | EngineStartError
  | EngineFailure
  | BenchmarkSoundLost
  | Cause.TimeoutError

/** Why the watchdog gave up: the module didn't load, the first engine didn't start, or engines failed too often. */
export type GaveUp = 'load' | 'start' | 'often'

export type EngineState = Data.TaggedEnum<{
  /** After a failure, an engine in place of the one that failed; otherwise the first, or one a restart asked for. */
  Starting: { readonly afterFailure: boolean }
  /** Built from the project. */
  Ready: {}
  Failed: { readonly cause: Cause.Cause<RunFailure | EngineLoadError>; readonly gaveUp: GaveUp }
  /** Its audio thread hung: nothing touches the context any more, and the page reopens unless it hung too often. */
  Hung: { readonly error: AudioThreadHung }
}>

export const EngineState = Data.taggedEnum<EngineState>()

export type BenchmarkState = Data.TaggedEnum<{
  Idle: {}
  Rendering: {}
  Done: { readonly result: BenchmarkResult }
  Failed: { readonly cause: Cause.Cause<BenchmarkFailure> }
}>

export const BenchmarkState = Data.taggedEnum<BenchmarkState>()

/** What the watchdog has done since the page opened, or since the tab did, if the page reopened after a hang. */
export interface Restarts {
  /** Times it started a new engine after a failure, or reopened the page. */
  readonly count: number
  /** Why the engine failed before the last of them; none before the first. */
  readonly last: Option.Option<Cause.Cause<RunFailure>>
  /** Milliseconds from the page learning of the last failure to the new engine playing; none until it plays. */
  readonly backInMs: Option.Option<number>
}

/** Load turns the master's filter for a while, and the project is rebuilt meanwhile. */
export type LoadState = Data.TaggedEnum<{
  Idle: {}
  Running: {}
  Done: { readonly moves: number; readonly rebuilds: number; readonly seconds: number }
  /** The engine sleeps until Play: its compiler would hold the moves. */
  Asleep: {}
  /** The project has no filter on the master to turn. */
  NoFilter: {}
  /** Stopped early, by a bug or by the page closing. */
  Failed: { readonly cause: Cause.Cause<never> }
}>

export const LoadState = Data.taggedEnum<LoadState>()

/** An engine event as the page lists it: the number tells it apart from the same event again. */
export interface ShownEvent {
  readonly number: number
  readonly event: EngineEvent
}

/** What a frame draws, read once per frame. */
export interface Frame {
  /** Which engine it is, counted from the page's opening: each starts its board's counts afresh. */
  readonly engine: number
  /** None until the engine has played a block. */
  readonly telemetry: Telemetry | undefined
  /**
   * Where the transport is heard now: its tick, between two whole ones as time goes, and the loop it goes round in;
   * none while stopped or before it is heard.
   */
  readonly heard: Heard | undefined
  /** Counts the browser keeps up to date; none where it reports none. */
  readonly stats: PlaybackStats | undefined
}

/** Where Play stands: while the sound wakes, it waits for it. */
export type Transport = 'stopped' | 'starting' | 'playing'

/**
 * The engine, from when the page opens to when it closes: built from the project at once, on an AudioContext that
 * stays asleep until Play wakes it; a restart makes a new one on the same context. An engine that fails is replaced by
 * itself, until the third failure within a minute. One whose audio thread hangs makes the page reopen, playing on if it
 * played, until the third hang within a minute.
 */
export interface EngineHost {
  /** Failed once the watchdog gives up; hung for good once the page no longer reopens. */
  readonly state: Atom.Atom<EngineState>
  readonly restarts: Atom.Atom<Restarts>
  /** Whether the engine's context runs: asleep until Play wakes it, unless the browser lets it run at once. */
  readonly awake: Atom.Atom<boolean>
  /** Each engine plays the arrangement as this says. */
  readonly transport: Atom.Atom<Transport>
  /**
   * Plays the arrangement, waking the sound first if it sleeps; stops it if it plays. It does nothing while the sound wakes,
   * or while the engine isn't ready.
   */
  readonly togglePlay: Effect.Effect<void>
  /** Wakes the sound if it sleeps, as a note played by hand needs it; nothing while the engine isn't ready. */
  readonly wake: Effect.Effect<void>
  /**
   * Stops the engine and builds a new one from the project, playing on from the loop's start if it played; the watchdog
   * counts failures afresh. It does nothing once the audio thread hung, or while it doesn't answer: stopping the engine
   * then, or a new one on its context, would block the page.
   */
  readonly restart: Effect.Effect<void>
  readonly rebuild: Effect.Effect<void>
  /** A device edit and a live edit the engine must refuse. */
  readonly sendBadCommand: Effect.Effect<void>
  /** A sound the engine must refuse, under its own name. */
  readonly storeBadSample: Effect.Effect<void>
  /** Panics the engine's audio thread, for the watchdog to recover from. */
  readonly panicAudio: Effect.Effect<void>
  /** Panics the engine's build thread, as `panicAudio` does the audio thread. */
  readonly panicBuild: Effect.Effect<void>
  /** Hangs the engine's audio thread, for the watchdog to recover from. */
  readonly hangAudio: Effect.Effect<void>
  /** Hangs the engine's build thread, as `hangAudio` does the audio thread. */
  readonly hangBuild: Effect.Effect<void>
  /** Breaks the engine's command stream, for the watchdog to recover from. */
  readonly breakStream: Effect.Effect<void>
  readonly samples: Atom.Atom<ReadonlyArray<SampleLine>>
  /** The newest events first, since the page opened: an engine's stay after it fails, to show what came before. */
  readonly events: Atom.Atom<ReadonlyArray<ShownEvent>>
  readonly benchmark: Atom.Atom<BenchmarkState>
  readonly runBenchmark: Effect.Effect<void>
  readonly load: Atom.Atom<LoadState>
  /**
   * Holds the master's filter cutoff to a new value 1000 times a second for `loadSeconds`, as a knob turn would, and
   * rebuilds the project at the start of each second; then lets go, so the document never changes. Not while the
   * engine sleeps, nor twice at once.
   */
  readonly runLoad: Effect.Effect<void>
  /** Cheap enough for every frame; none without an engine. */
  readonly frame: () => Frame | undefined
}

export const EngineHost = Context.Service<EngineHost>('EngineHost')

/** The engine's module, compiled from when the page opens, apart from the project's load. */
export interface EngineModule {
  readonly module: Effect.Effect<WebAssembly.Module, EngineLoadError>
}

export const EngineModule = Context.Service<EngineModule>('EngineModule')

export const engineModuleLayer = Layer.effect(
  EngineModule,
  Effect.map(Effect.forkScoped(compileEngine), (compiling) => ({ module: Fiber.join(compiling) }))
)

/** Newest first. */
const shownEvents = 8

const badSampleName = 'Bad sample'

/** A device edit and a live edit for node 0, a handle the compiler never hands out: both refused. */
const badEdits: Transaction = {
  edits: [DeviceEdit.DestroyNode({ node: NodeHandle(0) })],
  commands: [Command.SetParam({ node: NodeHandle(0), param: 1, value: 0 })]
}

const ringFull = Effect.logWarning('The command ring is full')

/** Warns when the command ring had no room: whether it was written is the caller's to act on. */
const warnedSend =
  (send: Send, warn: () => void): Send =>
  (transaction) =>
    Boolean.match(send(transaction), {
      onTrue: () => true,
      onFalse: () => {
        warn()
        return false
      }
    })

/** The watchdog gives up on this many failures within `failureWindowNanos`. */
const failureLimit = 3

/** A minute. */
const failureWindowNanos = 60_000_000_000n

/** A minute of the time of day, which goes on across a reopening, unlike the page's own clocks. */
const hangWindowMillis = 60_000

/** How often a new engine is looked at until it plays, after a failure: a browser's chained timers go no oftener. */
const backEvery = Duration.millis(4)

const loadSeconds = 10
const movesPerSecond = 1000

/** A browser's timer is too coarse to move once a millisecond. */
const loadTick = Duration.millis(10)

/** After a stall, no more at once: a knob's pointer moves come together too. */
const mostMovesAtOnce = movesPerSecond / 10

const millisSince = (start: bigint, now: bigint) => Number(now - start) / 1_000_000

/** What Load turns: a parameter's hold, and its value at a knob's position. */
interface Turned {
  readonly target: HoldTarget
  readonly valueAt: (position: number) => number
}

/** One engine from its start to the next restart, and what plays it. */
interface Run {
  readonly send: Send
  readonly compiler: Compiler
  readonly storeBadSample: Effect.Effect<void>
  readonly frame: () => Frame
  /** Whether its audio thread answers in time. */
  readonly answers: Effect.Effect<boolean>
  readonly breakStream: () => boolean
}

export const engineHostLayer = Layer.effect(
  EngineHost,
  Effect.gen(function* () {
    const registry = yield* AtomRegistry.AtomRegistry
    const { project, listening, holds, played, auditions } = yield* ProjectSession
    const { module: compiled } = yield* EngineModule
    const { context, startEngine, library } = yield* AudioOutput
    const { taken, reopen } = yield* PageReopen
    const loading = yield* sampleLoading
    // A page reopened after a hang starts in place of the engine that hung.
    const state = Atom.make<EngineState>(EngineState.Starting({ afterFailure: Option.isSome(taken) })).pipe(
      Atom.keepAlive
    )
    // Playing on needs a context that runs without a click: a reopened page has the click the page before it had.
    const playsOn: Transport = Boolean.match(
      Option.exists(taken, ({ playing }) => playing) && context.state === 'running',
      {
        onTrue: () => 'playing',
        onFalse: () => 'stopped'
      }
    )
    const transport = Atom.make<Transport>(playsOn).pipe(Atom.keepAlive)
    const playing = Atom.make((get) => get(transport) === 'playing').pipe(Atom.keepAlive)
    const stop = Effect.sync(() => registry.set(transport, 'stopped'))
    const samples = Atom.make(manifestLines).pipe(Atom.keepAlive)
    const events = Atom.make<ReadonlyArray<ShownEvent>>([]).pipe(Atom.keepAlive)
    const restarts = Atom.make<Restarts>(
      Option.match(taken, {
        onNone: () => ({ count: 0, last: Option.none(), backInMs: Option.none() }),
        onSome: ({ restarts, hang }) => ({
          count: restarts,
          last: Option.some(Cause.fail(new AudioThreadHung({ message: hang }))),
          backInMs: Option.none()
        })
      })
    ).pipe(Atom.keepAlive)
    const benchmark = Atom.make<BenchmarkState>(BenchmarkState.Idle()).pipe(Atom.keepAlive)
    const load = Atom.make<LoadState>(LoadState.Idle()).pipe(Atom.keepAlive)
    const current = Atom.make(Option.none<Run>()).pipe(Atom.keepAlive)

    const show: ShowSample = (name, status) =>
      Effect.sync(() => registry.update(samples, (lines) => withStatus(lines, name, status)))
    const sounds = library(show)
    const stats = Option.getOrUndefined(playbackStatsOf(context))

    /** Whether the context runs: the compiler holds its changes while it doesn't. */
    const running = Atom.make(context.state === 'running').pipe(Atom.keepAlive)
    const followState = () => registry.set(running, context.state === 'running')
    yield* Effect.acquireRelease(
      Effect.sync(() => context.addEventListener('statechange', followState)),
      () => Effect.sync(() => context.removeEventListener('statechange', followState))
    )

    /**
     * Since the sound went silent, on the monotonic clock: the first failure while playing that no engine has made good
     * yet, however many failed to start after it.
     */
    const silentSince = yield* Ref.make(Option.none<bigint>())

    /** How long since `since` once the engine plays; nothing if the arrangement stops first. */
    const backIn = (engine: OutputEngine, since: bigint) => {
      const plays = () => {
        const telemetry = engine.readTelemetry()
        return telemetry !== undefined && telemetry.blocks > 0 && telemetry.playing
      }
      return Effect.void.pipe(
        Effect.repeat({ while: () => !plays() && registry.get(playing), schedule: Schedule.spaced(backEvery) }),
        Effect.andThen(Ref.set(silentSince, Option.none())),
        Effect.andThen(
          Clock.monotonicTimeNanos.pipe(
            Effect.flatMap((now) =>
              Effect.sync(() =>
                registry.update(restarts, (counted) => ({ ...counted, backInMs: Option.some(millisSince(since, now)) }))
              )
            ),
            Effect.when(Effect.sync(plays))
          )
        )
      )
    }

    const engines = yield* Ref.make(0)

    /** Until it fails or a restart interrupts it, which stops its engine. */
    const run = (module: WebAssembly.Module, afterFailure: boolean) =>
      Effect.gen(function* () {
        registry.set(state, EngineState.Starting({ afterFailure }))
        const number = yield* Ref.updateAndGet(engines, (count) => count + 1)
        registry.set(samples, manifestLines)
        const engine = yield* startInTime(startEngine(module))
        // From the compiler's sending, which isn't Effect's.
        const warn = yield* FiberSet.makeRuntime<never>()
        const send = warnedSend(engine.send, () => warn(ringFull))
        const compiler = yield* compile(
          project,
          { listening, holds: played, playing, auditions },
          { send, storeSample: engine.storeSample, evictSample: engine.evictSample, running },
          sounds
        )
        const stores = yield* FiberSet.make<void, BuildThreadError>()
        const bad = badSample(badSampleName, context.sampleRate, show)
        const tickHeard = heardTickReader(context)
        const started: Run = {
          send,
          compiler,
          storeBadSample: Effect.asVoid(
            FiberSet.run(
              stores,
              storeWithStatus(engine.storeSample, bad.hash, bad.load, (status) => show(bad.name, status))
            )
          ),
          frame: () => {
            const telemetry = engine.readTelemetry()
            const heard = Option.getOrUndefined(tickHeard(telemetry, performance.now()))
            return { engine: number, telemetry, heard, stats }
          },
          answers: answers(engine),
          breakStream: engine.breakStream
        }
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            registry.set(current, Option.some(started))
            registry.set(state, EngineState.Ready())
          }),
          () => Effect.sync(() => registry.set(current, Option.none()))
        )
        yield* Effect.flatMap(
          Ref.get(silentSince),
          Option.match({
            onNone: () => Effect.void,
            onSome: (since) => Effect.asVoid(Effect.forkScoped(backIn(engine, since)))
          })
        )
        const eventLog = Stream.runForEach(engine.events, (event) =>
          Effect.sync(() =>
            registry.update(events, (shown) =>
              [{ number: (shown[0]?.number ?? 0) + 1, event }, ...shown].slice(0, shownEvents)
            )
          )
        )
        // A failure to read events, or of a store, is a bug and stops the engine.
        yield* Effect.raceAllFirst([
          engine.failure,
          eventLog,
          compiler.failure,
          FiberSet.join(stores),
          hangs(engine, context)
        ])
        // None of them ends but by failing; one that did would leave the page without an engine.
        return yield* Effect.die(new Error('The engine stopped without failing'))
      }).pipe(Effect.scoped, Effect.provideService(AtomRegistry.AtomRegistry, registry))

    /** Nothing plays the arrangement, and Play can't be pressed. */
    const giveUp = (cause: Cause.Cause<RunFailure>, gaveUp: GaveUp) =>
      Effect.sync(() => registry.set(state, EngineState.Failed({ cause, gaveUp }))).pipe(Effect.andThen(stop))

    /**
     * The engine let go of its audio thread, and the page reopens in a new process, which the thread doesn't follow;
     * playing, it plays on. On the `failureLimit`th hang within the window it stays instead, stopped, with a context
     * nothing may touch, as it does if it can't take along how often it hung.
     */
    const hung = (error: AudioThreadHung) =>
      Effect.gen(function* () {
        registry.set(state, EngineState.Hung({ error }))
        const now = yield* Clock.currentTimeMillis
        const before = Option.match(taken, { onNone: () => [], onSome: ({ hangs }) => hangs })
        const recent = [...before.filter((at) => now - at < hangWindowMillis), now]
        const restarted = registry.get(restarts).count + 1
        yield* Boolean.match(recent.length >= failureLimit, {
          onTrue: () => stop,
          onFalse: () =>
            reopen({ hangs: recent, playing: registry.get(playing), restarts: restarted, hang: error.message }).pipe(
              Effect.catch((cannot) =>
                Effect.logError("The page couldn't reopen after the hang", cannot).pipe(Effect.andThen(stop))
              )
            )
        })
      })

    /**
     * Engines one after another, each in place of one that failed, until `failureLimit` fail within the window. A first
     * start that fails isn't tried again: it would fail the same way.
     */
    const watched = (
      module: WebAssembly.Module,
      failures: ReadonlyArray<bigint>,
      afterFailure: boolean
    ): Effect.Effect<void> =>
      run(module, afterFailure).pipe(
        Effect.catchCause((cause) =>
          Boolean.match(Cause.hasInterruptsOnly(cause), {
            onTrue: () => Effect.void,
            onFalse: () =>
              Effect.logError(cause).pipe(
                // Unlike the time of day, it never jumps.
                Effect.andThen(Clock.monotonicTimeNanos),
                Effect.tap((now) =>
                  Effect.andThen(
                    Effect.sync(() =>
                      registry.update(restarts, (counted) => ({ ...counted, backInMs: Option.none() }))
                    ),
                    Ref.update(silentSince, (since) =>
                      Option.orElse(since, () => Option.liftPredicate(now, () => registry.get(playing)))
                    )
                  )
                ),
                Effect.flatMap((now) => {
                  const recent = [...failures.filter((at) => now - at < failureWindowNanos), now]
                  const restart = () =>
                    Boolean.match(recent.length >= failureLimit, {
                      onTrue: () => giveUp(cause, 'often'),
                      onFalse: () =>
                        Effect.andThen(
                          Effect.sync(() =>
                            registry.update(restarts, (counted) => ({
                              ...counted,
                              count: counted.count + 1,
                              last: Option.some(cause)
                            }))
                          ),
                          watched(module, recent, true)
                        )
                    })
                  return Option.match(Cause.findErrorOption(cause), {
                    // A bug.
                    onNone: restart,
                    onSome: (error) =>
                      Match.valueTags(error, {
                        AudioThreadHung: hung,
                        // A first start that fails isn't tried again: it would fail the same way.
                        EngineStartError: () =>
                          Boolean.match(failures.length === 0, {
                            onTrue: () => giveUp(cause, 'start'),
                            onFalse: restart
                          }),
                        ProcessorError: restart,
                        BuildThreadError: restart,
                        CommandStreamError: restart,
                        BuildThreadHung: restart
                      })
                  })
                })
              )
          })
        )
      )

    const runs = yield* FiberHandle.make<void, unknown>()
    // One restart at a time, each engine after the one before has stopped: two never share the page's atoms.
    const restarting = yield* Semaphore.make(1)
    const start = (afterFailure: boolean) =>
      compiled.pipe(
        // Interrupted, as the page closes, it didn't fail.
        Effect.tapCause((cause) =>
          Effect.logError(cause).pipe(
            Effect.andThen(Effect.sync(() => registry.set(state, EngineState.Failed({ cause, gaveUp: 'load' })))),
            Effect.when(Effect.sync(() => !Cause.hasInterruptsOnly(cause)))
          )
        ),
        Effect.andThen((module) =>
          FiberHandle.clear(runs).pipe(Effect.andThen(FiberHandle.run(runs, watched(module, [], afterFailure))))
        ),
        Semaphore.withPermit(restarting),
        Effect.ignore
      )
    // The page draws meanwhile.
    yield* Effect.forkScoped(start(Option.isSome(taken)))

    const withRun = (use: (run: Run) => Effect.Effect<void>) =>
      Effect.suspend(() => Option.match(registry.get(current), { onNone: () => Effect.void, onSome: use }))

    /** The master filter's cutoff, which Load turns. */
    const masterCutoff = () =>
      Option.gen(function* () {
        const filter = yield* Array.findFirst(registry.get(project.master).slots, (slot) => slot.name === 'filter')
        const cutoff = yield* Array.findFirst(filter.plugin.params, (param) => param.id === 'cutoff')
        const turned: Turned = {
          target: HoldTarget.SlotParam({ slot: filter.id, param: cutoff.id }),
          valueAt: (position) => paramValue(cutoff, position)
        }
        return turned
      })

    const loadOn = ({ target, valueAt }: Turned) =>
      Effect.gen(function* () {
        const moves = movesPerSecond * loadSeconds
        const done = yield* Ref.make({ moves: 0, rebuilds: 0 })
        // A sweep a second through the upper octaves, each move to a new value.
        const moveTo = (move: number) => {
          const position = 0.75 + 0.2 * Math.sin((2 * Math.PI * move) / movesPerSecond)
          registry.update(holds, (held) => holding(held, target, valueAt(position)))
        }
        const started = yield* Clock.monotonicTimeNanos
        // As many as the pace calls for by the end of this tick: a page slower than its timer catches up.
        const tick = Effect.gen(function* () {
          const elapsed = millisSince(started, yield* Clock.monotonicTimeNanos) + Duration.toMillis(loadTick)
          const made = (yield* Ref.get(done)).moves
          const due = Math.min(Math.round((elapsed * movesPerSecond) / 1000), moves) - made
          const count = Math.min(due, mostMovesAtOnce)
          // Plain calls: Load measures what moves cost the page, not what Effect adds to each.
          yield* Effect.sync(() => Array.range(made, made + count - 1).forEach(moveTo)).pipe(
            Effect.when(Effect.succeed(count > 0))
          )
          yield* Ref.update(done, (done) => ({ ...done, moves: done.moves + Math.max(count, 0) }))
          yield* Effect.sleep(loadTick)
          return (yield* Ref.get(done)).moves
        })
        const moving = tick.pipe(Effect.repeat({ while: (made) => made < moves }))
        const rebuilding = withRun((run) =>
          Effect.flatMap(run.compiler.rebuild, (rebuilt) =>
            Ref.update(done, (made) => ({
              ...made,
              rebuilds: made.rebuilds + Boolean.match(rebuilt, { onTrue: () => 1, onFalse: () => 0 })
            }))
          )
        ).pipe(
          Effect.andThen(Effect.sleep(Duration.seconds(1))),
          Effect.replicateEffect(loadSeconds, { discard: true })
        )
        registry.set(load, LoadState.Running())
        yield* Effect.all([moving, rebuilding], { concurrency: 'unbounded' }).pipe(
          Effect.ensuring(Effect.sync(() => registry.update(holds, (held) => lettingGo(held, target)))),
          Effect.onExit((exit) =>
            Effect.gen(function* () {
              const now = yield* Clock.monotonicTimeNanos
              const made = yield* Ref.get(done)
              registry.set(
                load,
                Exit.match(exit, {
                  onSuccess: () => LoadState.Done({ ...made, seconds: millisSince(started, now) / 1000 }),
                  onFailure: (cause) => LoadState.Failed({ cause })
                })
              )
            })
          )
        )
      })

    // Each press that breaks the engine has its own number: a panic's message names it.
    const presses = yield* Ref.make(0)
    const pressing = (send: (run: Run, code: number) => void) =>
      withRun((run) =>
        Effect.flatMap(
          Ref.updateAndGet(presses, (count) => count + 1),
          (code) => Effect.sync(() => send(run, code))
        )
      )

    const wake = Effect.promise(() => context.resume()).pipe(
      // One that runs is left alone: its audio thread may have hung, and the page would wait for it.
      Effect.when(Effect.sync(() => context.state !== 'running')),
      // At once, not at its event: what was held while asleep goes before the transport.
      Effect.andThen(Effect.sync(followState))
    )

    /** What a press of Play does, by where it stands. */
    const playPress: Record<Transport, Effect.Effect<void>> = {
      stopped: Effect.sync(() => registry.set(transport, 'starting')).pipe(
        Effect.andThen(wake),
        // A context that won't wake leaves the arrangement stopped.
        Effect.onError(() => stop),
        Effect.andThen(
          Effect.sync(() => registry.set(transport, 'playing')).pipe(
            // Unless a failure stopped it meanwhile.
            Effect.when(Effect.sync(() => registry.get(transport) === 'starting'))
          )
        ),
        Effect.asVoid
      ),
      // The sound wakes already.
      starting: Effect.void,
      playing: stop
    }

    return {
      state,
      restarts,
      awake: running,
      transport,
      // As the button: an engine that isn't ready isn't pressed.
      togglePlay: Effect.suspend(() => playPress[registry.get(transport)]).pipe(
        Effect.when(Effect.sync(() => EngineState.$is('Ready')(registry.get(state)))),
        Effect.asVoid
      ),
      wake: wake.pipe(Effect.when(Effect.sync(() => EngineState.$is('Ready')(registry.get(state)))), Effect.asVoid),
      restart: Effect.suspend(() =>
        Option.match(registry.get(current), {
          onNone: () => start(false),
          // A hang the watchdog has yet to notice is left to it.
          onSome: (run) => Effect.when(start(false), run.answers)
        })
      ).pipe(Effect.when(Effect.sync(() => !EngineState.$is('Hung')(registry.get(state)))), Effect.asVoid),
      rebuild: withRun((run) => Effect.asVoid(run.compiler.rebuild)),
      sendBadCommand: withRun((run) => Effect.sync(() => void run.send(badEdits))),
      storeBadSample: withRun((run) => run.storeBadSample),
      panicAudio: pressing((run, code) => void run.send({ commands: [Command.PanicAudio({ code })] })),
      panicBuild: pressing((run, code) => void run.send({ edits: [DeviceEdit.PanicBuild({ code })] })),
      hangAudio: pressing((run, code) => void run.send({ commands: [Command.HangAudio({ code })] })),
      hangBuild: pressing((run, code) => void run.send({ edits: [DeviceEdit.HangBuild({ code })] })),
      breakStream: withRun((run) =>
        Effect.flatMap(Effect.sync(run.breakStream), (written) => ringFull.pipe(Effect.when(Effect.succeed(!written))))
      ),
      samples,
      events,
      benchmark,
      runBenchmark: Effect.gen(function* () {
        registry.set(benchmark, BenchmarkState.Rendering())
        const result = yield* benchmarkEngine(yield* compiled, benchmarkPlay)
        registry.set(benchmark, BenchmarkState.Done({ result }))
      }).pipe(
        Effect.catchCause((cause) => Effect.sync(() => registry.set(benchmark, BenchmarkState.Failed({ cause })))),
        Effect.provide(loading)
      ),
      load,
      runLoad: Effect.suspend(() =>
        Boolean.match(LoadState.$is('Running')(registry.get(load)), {
          // Not twice at once.
          onTrue: () => Effect.void,
          onFalse: () =>
            Boolean.match(registry.get(running), {
              onFalse: () => Effect.sync(() => registry.set(load, LoadState.Asleep())),
              onTrue: () =>
                Option.match(masterCutoff(), {
                  onNone: () => Effect.sync(() => registry.set(load, LoadState.NoFilter())),
                  onSome: loadOn
                })
            })
        })
      ),
      frame: () => Option.getOrUndefined(Option.map(registry.get(current), ({ frame }) => frame()))
    } satisfies EngineHost
  })
)
