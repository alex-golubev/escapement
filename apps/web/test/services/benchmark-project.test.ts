import type { SoundLibrary } from '@escapement/compiler'
import {
  blocks,
  blocksOf,
  framesPerTick,
  pageSounds,
  sampleRate,
  startEngine,
  type TestEngine
} from '@escapement/engine/testing'
import type { Sha256 } from '@escapement/engine-description'
import { barSteps, barTicks, defaultTrackStrip, readProject, stepTicks } from '@escapement/model'
import { Boolean, Deferred, Effect, Fiber, Option, type Scope } from 'effect'
import { Atom, AtomRegistry } from 'effect/reactivity'
import { expect, test } from 'vitest'
import { BenchmarkSoundLost, benchmarkProject, playBenchmarkProject } from '../../src/services/benchmark-project'
import { manifestSamples, type ShowSample } from '../../src/services/samples'

/** Shorter than a step, so each step starts in silence, after a millisecond's rise. */
const hit = () => ({
  sampleRate,
  channels: [
    // The rise until the peak, then the decay: the lower of the two.
    Float32Array.from({ length: 2400 }, (_, frame) => Math.min(frame / 48, 0.5 ** ((frame - 48) / 300)))
  ]
})

const [kick] = manifestSamples

/** The manifest's samples, each a hit loaded once `loading` lets it, but those `missing` leaves out. */
const library =
  ({
    missing = [],
    loading = () => Effect.void
  }: {
    missing?: ReadonlyArray<Sha256>
    loading?: (hash: Sha256) => Effect.Effect<void>
  }) =>
  (show: ShowSample): SoundLibrary => ({
    load: (hash) =>
      Option.liftPredicate(hash, (hash) => !missing.includes(hash)).pipe(
        Option.map((hash) => loading(hash).pipe(Effect.as(hit())))
      ),
    show: (hash, status) => show(manifestSamples.find((sample) => sample.hash === hash)?.name ?? hash, status)
  })

/** The benchmark's project going into the engine, its sounds stored as a worker's answers come in a later task. */
const playing = (engine: TestEngine, libraryShowing: (show: ShowSample) => SoundLibrary) =>
  Effect.gen(function* () {
    const sounds = yield* pageSounds(engine)
    const fiber = yield* playBenchmarkProject(
      { send: engine.send, storeSample: sounds.store, evictSample: sounds.evict, running: Atom.make(true) },
      libraryShowing
    ).pipe(Effect.forkScoped)
    yield* sounds.settled
    return { fiber, sounds }
  })

const run = <A, E>(effect: Effect.Effect<A, E, AtomRegistry.AtomRegistry | Scope.Scope>) =>
  Effect.runPromise(effect.pipe(Effect.scoped, Effect.provideService(AtomRegistry.AtomRegistry, AtomRegistry.make())))

const stepFrames = stepTicks * framesPerTick

/** Each track adds up to its volume, unless set: past three and a half of them only if all four sound. */
const allFour = 3.5 * defaultTrackStrip.volume

test('the benchmark project has a track for each sample, a note on every step of its clip', () => {
  const { tracks, clips, patterns } = readProject(benchmarkProject()).value
  expect(tracks).toHaveLength(manifestSamples.length)
  expect(clips).toHaveLength(manifestSamples.length)
  expect(patterns.map(({ notes }) => notes.length)).toEqual(manifestSamples.map(() => barSteps))
})

test('the benchmark plays its project: every track sounds on every step, the engine refuses nothing and loses no note', () =>
  run(
    Effect.gen(function* () {
      const engine = startEngine({ initial: {} })
      const { fiber } = yield* playing(engine, library({}))
      yield* Fiber.join(fiber)
      const loop = blocksOf(barTicks * framesPerTick)
      // The first loop starts as the nodes fade in.
      blocks(engine, loop)
      const heard = blocks(engine, loop)
      const peaks = Array.from({ length: barSteps }, (_, step) =>
        heard.subarray(step * stepFrames, (step + 1) * stepFrames).reduce((peak, x) => Math.max(peak, Math.abs(x)), 0)
      )
      expect(peaks.every((peak) => peak > allFour)).toBe(true)
      expect(engine.readEvents()).toEqual([])
      expect(engine.readTelemetry()).toMatchObject({ playing: true, lostNotes: 0 })
    })
  ))

test('the benchmark waits until each sound of its project is in', () =>
  run(
    Effect.gen(function* () {
      const loaded = yield* Deferred.make<void>()
      const engine = startEngine({ initial: {} })
      const { fiber, sounds } = yield* playing(
        engine,
        library({
          loading: (hash) =>
            Boolean.match(hash === kick.hash, { onTrue: () => Deferred.await(loaded), onFalse: () => Effect.void })
        })
      )
      expect(fiber.pollUnsafe()).toBeUndefined()
      yield* Deferred.succeed(loaded, undefined)
      yield* sounds.settled
      yield* Fiber.join(fiber)
    })
  ))

test('the benchmark fails once a sound of its project does not get in, rather than time its silence', () =>
  run(
    Effect.gen(function* () {
      const engine = startEngine({ initial: {} })
      const { fiber } = yield* playing(engine, library({ missing: [kick.hash] }))
      const error = yield* Fiber.join(fiber).pipe(Effect.flip)
      expect(error).toEqual(new BenchmarkSoundLost({ message: `${kick.name}: no such sound` }))
    })
  ))
