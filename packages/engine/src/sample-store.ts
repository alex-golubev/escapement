import type { Sha256 } from '@escapement/engine-description'
import { Array, Boolean, Data, Deferred, Effect, FiberSet, Match, Option } from 'effect'
import type { BuildThreadError } from './errors'
import type { EvictSample, FromBuildThread, SampleMessage, StoreSample } from './protocol'
import { type SamplePcm, SampleRefused, type SampleUnavailable } from './samples'

/** The page's end of the build thread, as far as sounds go. */
export interface BuildThreadPort {
  readonly postMessage: (message: SampleMessage, transfer: Transferable[]) => void
  readonly addEventListener: (type: 'message', listener: (event: MessageEvent<FromBuildThread>) => void) => void
  readonly removeEventListener: (type: 'message', listener: (event: MessageEvent<FromBuildThread>) => void) => void
}

const isHandedOver = ({ buffer }: Float32Array) => buffer instanceof ArrayBuffer && buffer.detached

const problemIf = (found: boolean, problem: string) =>
  Boolean.match(found, { onTrue: () => Option.some(problem), onFalse: () => Option.none<string>() })

/** What no sound can be, if the sound is that; the engine counts frames in 32 bits. */
const malformed = ({ channels }: SamplePcm): Option.Option<string> =>
  Option.match(Array.head(channels), {
    onNone: () => Option.some('A sound to store has no channel'),
    onSome: ({ length: frames }) =>
      // It would pass for a sound without frames: its length is 0 now.
      problemIf(
        channels.some(isHandedOver),
        'A channel of a sound to store went over to the engine before: a load makes a new sound each time'
      ).pipe(
        Option.orElse(() =>
          problemIf(
            channels.some((channel) => channel.length !== frames),
            'The channels of a sound to store differ in length'
          )
        ),
        Option.orElse(() =>
          problemIf(frames > 0xffffffff, `A sound of ${frames} frames is longer than the engine can count`)
        )
      )
  })

/** The channel's buffer, if the channel is the whole of it. */
const wholeBuffer = (channel: Float32Array): Option.Option<ArrayBuffer> =>
  Option.liftPredicate(
    channel.buffer,
    (buffer): buffer is ArrayBuffer =>
      buffer instanceof ArrayBuffer && channel.byteOffset === 0 && channel.byteLength === buffer.byteLength
  )

/**
 * The channels as they go to the build thread, and the buffers that go with them, each once: a channel that is a whole
 * buffer of its own, and otherwise a copy, so no one else's numbers go too.
 */
const handedOver = (channels: ReadonlyArray<Float32Array>) => {
  const sent = channels.map((channel) =>
    Option.match(wholeBuffer(channel), {
      onSome: (buffer) => ({ channel, buffer }),
      onNone: () => {
        const copy = new Float32Array(channel)
        return { channel: copy, buffer: copy.buffer }
      }
    })
  )
  return { channels: sent.map(({ channel }) => channel), transfer: [...new Set(sent.map(({ buffer }) => buffer))] }
}

/** Done once the sound is in; every store of it waits for it, and its eviction interrupts it. */
type Answer = Deferred.Deferred<void, SampleUnavailable | SampleRefused>

/** A sound in the engine, or on its way there. */
type Kept = Data.TaggedEnum<{
  Loading: { readonly answered: Answer }
  /** In its message to the build thread, and in the engine once answered. */
  Sent: { readonly answered: Answer; readonly id: number }
}>

const Kept = Data.taggedEnum<Kept>()

export interface SampleStore {
  /**
   * Ends once the sound is in the engine. A sound stored and not evicted since is not loaded again: the store waits for
   * the same answer. One evicted is, though the engine may still have it for its nodes and take it without a copy.
   */
  readonly store: (
    hash: Sha256,
    load: Effect.Effect<SamplePcm, SampleUnavailable>
  ) => Effect.Effect<void, SampleUnavailable | SampleRefused | BuildThreadError>
  /** True if the sound was stored or on its way, and not evicted since. Interrupts the stores that wait for it. */
  readonly evict: (hash: Sha256) => boolean
}

/**
 * The sounds of one engine, while the scope is open: which ones it has, sending only those it lacks, and evicting. A
 * sound's load runs apart from the stores that wait for it, until the answer or the eviction; the scope's end
 * interrupts those still waiting.
 */
export const sampleStore = Effect.fnUntraced(function* (
  worker: BuildThreadPort,
  failure: Effect.Effect<never, BuildThreadError>
) {
  const kept = new Map<Sha256, Kept>()
  /** Each sound sent, by its message, until the answer. */
  const sent = new Map<number, Sha256>()
  const state = { next: 1, open: true }
  const loads = yield* FiberSet.make()
  const runLoad = yield* FiberSet.runtime(loads)()

  const isKept = (hash: Sha256, answered: Answer) => kept.get(hash)?.answered === answered

  /** Unless something newer took its place. */
  const forget = (hash: Sha256, answered: Answer) =>
    Boolean.match(isKept(hash, answered), {
      onTrue: () => {
        kept.delete(hash)
      },
      onFalse: () => {}
    })

  /** Ends the wait for the sound a message was about, unless it was evicted since. */
  const answer = (id: number, result: (hash: Sha256) => Effect.Effect<void, SampleRefused>) =>
    Option.match(
      Option.flatMap(Option.fromUndefinedOr(sent.get(id)), (hash) =>
        Option.map(Option.fromUndefinedOr(kept.get(hash)), ({ answered }) => ({ hash, answered }))
      ),
      {
        onNone: () => {},
        onSome: ({ hash, answered }) => {
          sent.delete(id)
          Deferred.doneUnsafe(answered, result(hash))
        }
      }
    )

  const onMessage = ({ data }: MessageEvent<FromBuildThread>) =>
    Match.valueTags(data, {
      Ready: () => {},
      Pong: () => {},
      SampleStored: ({ id }) => answer(id, () => Effect.void),
      SampleRefused: ({ id, reason }) =>
        answer(id, (hash) => {
          // The next store of it loads it again.
          kept.delete(hash)
          return Effect.fail(new SampleRefused({ reason }))
        })
    })

  /** The checks and the post in one step: an eviction or another post in between would undo what they found. */
  const send = (hash: Sha256, answered: Answer, sound: SamplePcm) =>
    Effect.suspend(() =>
      Option.match(malformed(sound), {
        onSome: (problem) => Effect.die(new Error(problem)),
        onNone: () =>
          Boolean.match(isKept(hash, answered), {
            // Evicted as the load ended.
            onFalse: () => Effect.void,
            onTrue: () => {
              const id = state.next
              state.next = id + 1
              const { channels, transfer } = handedOver(sound.channels)
              const message: StoreSample = { _tag: 'StoreSample', id, hash, sampleRate: sound.sampleRate, channels }
              worker.postMessage(message, transfer)
              kept.set(hash, Kept.Sent({ answered, id }))
              sent.set(id, hash)
              return Effect.void
            }
          })
      })
    )

  /** A load that fails, or a sound that is the caller's bug, ends the wait with it. */
  const loadAndSend = (hash: Sha256, answered: Answer, load: Effect.Effect<SamplePcm, SampleUnavailable>) =>
    Effect.raceFirst(
      Effect.flatMap(load, (sound) => send(hash, answered, sound)).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            forget(hash, answered)
            Deferred.doneUnsafe(answered, Effect.failCause(cause))
          })
        )
      ),
      Effect.ignore(Deferred.await(answered))
    )

  const store: SampleStore['store'] = (hash, load) =>
    Effect.suspend(() =>
      Boolean.match(state.open, {
        onFalse: () => Effect.interrupt,
        onTrue: () => {
          const answered = Option.match(Option.fromUndefinedOr(kept.get(hash)), {
            onSome: ({ answered }) => answered,
            onNone: () => {
              const answered: Answer = Deferred.makeUnsafe()
              kept.set(hash, Kept.Loading({ answered }))
              runLoad(loadAndSend(hash, answered, load))
              return answered
            }
          })
          return Effect.raceFirst(Deferred.await(answered), failure)
        }
      })
    )

  const evict: SampleStore['evict'] = (hash) =>
    Option.match(Option.fromUndefinedOr(kept.get(hash)), {
      onNone: () => false,
      onSome: (entry) => {
        kept.delete(hash)
        Kept.$match(entry, {
          // Its load sends nothing now.
          Loading: () => {},
          Sent: ({ id }) => {
            sent.delete(id)
            const message: EvictSample = { _tag: 'EvictSample', hash }
            worker.postMessage(message, [])
          }
        })
        Deferred.doneUnsafe(entry.answered, Effect.interrupt)
        return true
      }
    })

  yield* Effect.acquireRelease(
    Effect.sync(() => worker.addEventListener('message', onMessage)),
    () =>
      Effect.sync(() => {
        state.open = false
        worker.removeEventListener('message', onMessage)
        kept.forEach(({ answered }) => Deferred.doneUnsafe(answered, Effect.interrupt))
        kept.clear()
        sent.clear()
      })
  )
  const sounds: SampleStore = { store, evict }
  return sounds
})
