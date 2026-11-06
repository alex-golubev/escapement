import { Array, Duration, Effect, Order, type Scope } from 'effect'
import { type Engine, startEngine, workletInfo } from './engine'
import { blockFrames, type WorkletInfo } from './protocol'

const sampleRate = 48_000
// The first renders are slower: the browser compiles hot code as it runs.
const warmUpRuns = 2
const measuredRuns = 5
/** Ample to load and store a project's sounds: a stalled fetch would keep the page rendering for good. */
const playTimeout = '10 seconds'

export interface BenchmarkResult extends WorkletInfo {
  /** Median over the measured runs. */
  readonly msPerBlock: number
  readonly minMsPerBlock: number
  readonly maxMsPerBlock: number
  readonly budgetMs: number
  readonly runs: number
}

/** Makes a new engine play what is measured, before its render starts; what it opens lasts the render. */
export type BenchmarkPlay<E, R> = (engine: Engine, context: BaseAudioContext) => Effect.Effect<void, E, R | Scope.Scope>

interface Run {
  readonly msPerBlock: number
  readonly info: WorkletInfo
}

const render = Effect.fn('render')(function* <E, R>(
  module: WebAssembly.Module,
  seconds: number,
  play: BenchmarkPlay<E, R>
) {
  const context = yield* Effect.sync(() => new OfflineAudioContext(2, seconds * sampleRate, sampleRate))
  const engine = yield* startEngine(context, module)
  yield* play(engine, context).pipe(Effect.raceFirst(engine.failure), Effect.timeout(playTimeout))
  // A failed engine renders silence fast, which would look like a great result.
  const [elapsed] = yield* Effect.promise(() => context.startRendering()).pipe(
    Effect.raceFirst(engine.failure),
    Effect.timed
  )
  const run: Run = {
    msPerBlock: Duration.toMillis(elapsed) / ((seconds * sampleRate) / blockFrames),
    info: yield* workletInfo(engine.node)
  }
  return run
}, Effect.scoped)

const median = (values: ReadonlyArray<number>) => Array.sort(values, Order.Number)[Math.floor(values.length / 2)]

/** Times offline renders of what `play` makes each new engine play, on the main thread: the worklet has no precise clock. */
export const benchmarkEngine = Effect.fn('benchmarkEngine')(function* <E, R>(
  module: WebAssembly.Module,
  play: BenchmarkPlay<E, R>,
  seconds = 10
) {
  yield* render(module, seconds, play).pipe(Effect.replicateEffect(warmUpRuns, { discard: true }))
  const runs = yield* render(module, seconds, play).pipe(Effect.replicateEffect(measuredRuns))
  const [first] = runs
  const times = Array.map(runs, (run) => run.msPerBlock)
  const result: BenchmarkResult = {
    msPerBlock: median(times),
    minMsPerBlock: Math.min(...times),
    maxMsPerBlock: Math.max(...times),
    budgetMs: (blockFrames / sampleRate) * 1000,
    runs: runs.length,
    ...first.info
  }
  return result
})
