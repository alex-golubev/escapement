import { Boolean, type Duration, Effect, Option, Ref, Stream } from 'effect'
import { RingBuffer } from 'ringbuf.js'
import { decodeEvent, type EngineEvent } from './events'
import { sizePrefixBytes } from './framing'

/** Events are rare: this holds seconds of them. */
const defaultCapacity = 64 * 1024

/** A timer, unlike animation frames, keeps running in a background tab. */
const defaultInterval: Duration.Input = '50 millis'

export const createEventRing = (capacity = defaultCapacity): SharedArrayBuffer =>
  RingBuffer.getStorageForCapacity(capacity, Uint8Array)

/** Takes the next event, if any. The worklet writes whole events only. */
export const eventReader = (storage: SharedArrayBuffer) => {
  const ring = new RingBuffer(storage, Uint8Array)
  const prefix = new Uint8Array(sizePrefixBytes)
  const prefixView = new DataView(prefix.buffer)
  const take = (bytes: Uint8Array, offset: number) => {
    const length = bytes.length - offset
    // biome-ignore lint/plugin/control-flow: the protocol's reader, plain JS
    if (ring.pop(bytes, length, offset) !== length) throw new Error('An event in the ring is cut short')
  }
  return (): EngineEvent | undefined => {
    // biome-ignore lint/plugin/control-flow: the protocol's reader, plain JS
    if (ring.availableRead() === 0) return undefined
    take(prefix, 0)
    const message = new Uint8Array(sizePrefixBytes + prefixView.getUint32(0, true))
    message.set(prefix)
    take(message, sizePrefixBytes)
    return decodeEvent(message)
  }
}

/**
 * For one listener at a time; a second one dies. Events are taken one by one as the listener pulls them,
 * so those it leaves stay in the ring.
 */
export const eventStream = (storage: SharedArrayBuffer, interval = defaultInterval) =>
  Effect.gen(function* () {
    const readEvent = eventReader(storage)
    const nextEvent: Effect.Effect<EngineEvent> = Effect.suspend(() =>
      Option.match(Option.fromNullishOr(readEvent()), {
        onNone: () => Effect.sleep(interval).pipe(Effect.andThen(nextEvent)),
        onSome: Effect.succeed
      })
    )
    const listening = yield* Ref.make(false)
    const claim = Effect.acquireRelease(
      Ref.getAndSet(listening, true).pipe(
        Effect.flatMap((taken) =>
          Boolean.match(taken, {
            onTrue: () => Effect.die(new Error("The engine's events already have a listener")),
            onFalse: () => Effect.void
          })
        )
      ),
      () => Ref.set(listening, false)
    )
    return Stream.unwrap(claim.pipe(Effect.as(Stream.fromEffectRepeat(nextEvent))))
  })
