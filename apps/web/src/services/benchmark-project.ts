import { type CompiledEngine, compile, type SoundLibrary } from '@escapement/compiler'
import type { BenchmarkPlay, BuildThreadError } from '@escapement/engine'
import {
  createProject,
  followProject,
  type Holds,
  type Listening,
  newWriter,
  noHolds,
  noAuditions,
  newListening,
  type Auditions,
  readProject,
  barSteps,
  toggleStep
} from '@escapement/model'
import { Data, Effect, Ref } from 'effect'
import { Atom, AtomRegistry } from 'effect/reactivity'
import * as Y from 'yjs'
import {
  isLost,
  manifestChannels,
  manifestLibrary,
  type SampleLoading,
  type ShowSample,
  sampleLoading,
  statusText
} from './samples'

/** A sound of the benchmark's project didn't get into the engine: the render would time its silence. */
export class BenchmarkSoundLost extends Data.TaggedError('BenchmarkSoundLost')<{ readonly message: string }> {}

/** The heaviest the slice plays: the starter project with every step of every channel on. */
export const benchmarkProject = () => {
  const doc = new Y.Doc()
  const by = newWriter('benchmark')
  createProject(doc, by, manifestChannels)
  const { channels, patterns } = readProject(doc).value
  patterns.forEach((pattern) =>
    channels.forEach((channel) =>
      Array.from({ length: barSteps }, (_, step) => toggleStep(doc, by, pattern.id, channel.id, step))
    )
  )
  return doc
}

/**
 * Compiles the benchmark's project into the engine, playing, while the scope is open, its sounds from the library made
 * to show to `show`. Ends once they are in; fails if any isn't.
 */
export const playBenchmarkProject = Effect.fnUntraced(function* (
  engine: CompiledEngine,
  libraryShowing: (show: ShowSample) => SoundLibrary
) {
  const lost = yield* Ref.make<ReadonlyArray<string>>([])
  const show: ShowSample = (name, status) =>
    Ref.update(lost, (sounds) => [...sounds, `${name}: ${statusText(status)}`]).pipe(
      Effect.when(Effect.succeed(isLost(status)))
    )
  const project = yield* followProject(benchmarkProject())
  const compiler = yield* compile(
    project,
    {
      listening: Atom.make<Listening>(newListening),
      holds: Atom.make<Holds>(noHolds),
      playing: Atom.make(true),
      auditions: Atom.make<Auditions>(noAuditions)
    },
    engine,
    libraryShowing(show)
  )
  yield* compiler.stored
  yield* Ref.get(lost).pipe(
    Effect.filterOrFail(
      (sounds) => sounds.length === 0,
      (sounds) => new BenchmarkSoundLost({ message: sounds.join('; ') })
    )
  )
})

/** What the page's Benchmark plays: the project, its sounds loaded by the render's context, apart from the page's. */
export const benchmarkPlay: BenchmarkPlay<BenchmarkSoundLost | BuildThreadError, SampleLoading> = (engine, context) =>
  Effect.flatMap(sampleLoading, (loading) =>
    playBenchmarkProject({ ...engine, running: Atom.make(true) }, (show) => manifestLibrary(context, show, loading))
  ).pipe(Effect.provideService(AtomRegistry.AtomRegistry, AtomRegistry.make()))
