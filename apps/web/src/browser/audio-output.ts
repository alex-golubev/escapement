import { startEngine } from '@escapement/engine'
import { Effect, Layer } from 'effect'
import { AudioOutput } from '../services/audio-output'
import { manifestLibrary, sampleLoading } from '../services/samples'

/** The browser's: an engine stopped by a restart leaves the context running, so the next one sounds without a click. */
export const audioOutputLayer = Layer.effect(
  AudioOutput,
  Effect.gen(function* () {
    // Asleep: the browser lets it run only once the page is clicked.
    const context = yield* Effect.acquireRelease(
      Effect.sync(() => new AudioContext({ latencyHint: 'interactive' })),
      (context) => Effect.promise(() => context.close())
    )
    const loading = yield* sampleLoading
    return {
      context,
      startEngine: (module) => startEngine(context, module),
      library: (show) => manifestLibrary(context, show, loading)
    } satisfies AudioOutput
  })
)
