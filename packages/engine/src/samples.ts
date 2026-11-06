import { Data } from 'effect'
import type { Rejection } from './rejections'

/** A decoded sound for the engine to store under its file's hash. */
export interface SamplePcm {
  readonly sampleRate: number
  /**
   * One or more, of one length. A channel that is a whole buffer of its own goes over to the engine, so it is empty
   * after; any other is copied.
   */
  readonly channels: ReadonlyArray<Float32Array>
}

/** The sound couldn't be had to store: loading, decoding or checking its file failed. Nothing went to the engine. */
export class SampleUnavailable extends Data.TaggedError('SampleUnavailable')<{ readonly message: string }> {}

/** The engine didn't store the sound; it plays on, and whatever refers to the sound stays silent. */
export class SampleRefused extends Data.TaggedError('SampleRefused')<{ readonly reason: Rejection }> {}
