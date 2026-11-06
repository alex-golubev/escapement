import type { Sha256 } from '@escapement/engine-description'
import type { SampleAnswer, SampleMessage, StoreSample } from '../protocol'
import type { Rejection } from '../rejections'

/** Numbers per part, 1 MiB: the longest a batch waits for a sound is one part's copy. */
export const partLength = 256 * 1024

/** How many numbers are left to copy, 0 once the sound is in; or why the engine refused it. */
export type Progress = number | Rejection

/** The engine's side: one sound at a time, and no eviction while one comes in. */
export interface SamplePool {
  readonly begin: (hash: Sha256, sampleRate: number, channels: number, frames: number) => Progress
  /** Copies the next numbers into the engine. */
  readonly copy: (numbers: Float32Array) => Progress
  readonly evict: (hash: Sha256) => void
}

/** Runs a step in a task of its own, after whatever arrived meanwhile. */
export type Schedule = (step: () => void) => void

/** Channel after channel, as the engine lays them out; no part crosses two. */
const partsOf = (channels: ReadonlyArray<Float32Array>) =>
  channels.flatMap((channel) =>
    Array.from({ length: Math.ceil(channel.length / partLength) }, (_, i) =>
      channel.subarray(i * partLength, (i + 1) * partLength)
    )
  )

/**
 * Takes the messages about sounds in the order sent, one at a time, each in steps of its own: a sound as a step to
 * begin and a step per part, so batches that arrive meanwhile wait for one part at most, and an eviction as one step.
 * Answers each sound once it is in or refused. The page sends only sounds with channels of one length.
 */
export const sampleQueue = (pool: SamplePool, schedule: Schedule, answer: (answer: SampleAnswer) => void) => {
  const waiting: Array<SampleMessage> = []
  const state = { busy: false }

  const goOn = (sound: StoreSample, progress: Progress, parts: ReadonlyArray<Float32Array>, index: number) => {
    const { id } = sound
    if (typeof progress === 'string') {
      answer({ _tag: 'SampleRefused', id, reason: progress })
      schedule(next)
    } else if (progress === 0) {
      answer({ _tag: 'SampleStored', id })
      schedule(next)
    } else {
      const part = parts[index]
      if (part === undefined) throw new Error(`The engine wants ${progress} numbers more than the sound has`)
      schedule(() => goOn(sound, pool.copy(part), parts, index + 1))
    }
  }

  const next = () => {
    const message = waiting.shift()
    if (message === undefined) {
      state.busy = false
      return
    }
    if (message._tag === 'EvictSample') {
      pool.evict(message.hash)
      schedule(next)
      return
    }
    const { hash, sampleRate, channels } = message
    goOn(message, pool.begin(hash, sampleRate, channels.length, channels[0]?.length ?? 0), partsOf(channels), 0)
  }

  return (message: SampleMessage) => {
    waiting.push(message)
    if (state.busy) return
    state.busy = true
    schedule(next)
  }
}
