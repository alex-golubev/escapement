import type { SoundLibrary } from '@escapement/compiler'
import type { Engine, EngineStartError, WithPlaybackStats } from '@escapement/engine'
import { Context, type Effect, type Scope } from 'effect'
import type { ShowSample } from './samples'

/** What the page needs of its audio context: one that runs in real time, waking when resumed. */
export type OutputContext = Pick<
  BaseAudioContext,
  'state' | 'sampleRate' | 'currentTime' | 'addEventListener' | 'removeEventListener'
> & {
  readonly resume: () => Promise<void>
  readonly getOutputTimestamp: () => AudioTimestamp
} & WithPlaybackStats

/** An engine as the page plays it; its worklet's node stays with the output. */
export type OutputEngine = Omit<Engine, 'node'>

/**
 * Where the page's sound goes while the page is open: one context, the engines started on it one after another, and the
 * project's sounds decoded for it.
 */
export interface AudioOutput {
  /** Asleep until resumed, unless the browser lets it run at once. */
  readonly context: OutputContext
  /** Plays on the context while the scope is open. */
  readonly startEngine: (module: WebAssembly.Module) => Effect.Effect<OutputEngine, EngineStartError, Scope.Scope>
  readonly library: (show: ShowSample) => SoundLibrary
}

export const AudioOutput = Context.Service<AudioOutput>('AudioOutput')
