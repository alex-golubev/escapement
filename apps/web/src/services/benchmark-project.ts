import { type CompiledEngine, compile, type SoundLibrary } from '@escapement/compiler'
import { type BenchmarkPlay, type BuildThreadError, noPlace } from '@escapement/engine'
import { plugins, Tick } from '@escapement/engine-description'
import {
  addClip,
  addNote,
  addTrack,
  type Auditions,
  barSteps,
  createProject,
  defaultNote,
  followProject,
  type Holds,
  type Listening,
  newListening,
  newWriter,
  noAuditions,
  noHolds,
  stepTicks
} from '@escapement/model'
import { Array, Data, Effect, Option, Ref } from 'effect'
import { Atom, AtomRegistry } from 'effect/reactivity'
import * as Y from 'yjs'
import {
  isLost,
  manifestLibrary,
  manifestSamples,
  type SampleLoading,
  type ShowSample,
  sampleLoading,
  statusText
} from './samples'

/** A sound of the benchmark's project didn't get into the engine: the render would time its silence. */
export class BenchmarkSoundLost extends Data.TaggedError('BenchmarkSoundLost')<{ readonly message: string }> {}

/** A track for each sample of the manifest, a sampler playing it a note on every step of a bar, from the start. */
export const benchmarkProject = () => {
  const doc = new Y.Doc()
  const by = newWriter('benchmark')
  createProject(doc, by)
  manifestSamples.forEach(({ hash }) =>
    Option.map(addTrack(doc, by, { plugin: plugins.sampler, sounds: { sample: hash } }), (track) =>
      Option.map(addClip(doc, by, { track, tick: Tick(0) }), (clip) =>
        Array.range(0, barSteps - 1).forEach((step) =>
          addNote(doc, by, clip, { tick: Tick(step * stepTicks), key: defaultNote.key, length: defaultNote.length })
        )
      )
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
      place: Atom.make(noPlace),
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
