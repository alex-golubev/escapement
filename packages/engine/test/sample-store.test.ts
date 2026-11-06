import { Sha256 } from '@escapement/engine-description'
import { Boolean, Deferred, Effect, Exit, Fiber, Match, Option, Scope } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { BuildThreadError } from '../src/errors'
import { answered } from '../src/ping'
import type { FromBuildThread, Ping, Pong, SampleMessage, StoreSample } from '../src/protocol'
import { sampleStore } from '../src/sample-store'
import { type SamplePcm, SampleRefused, SampleUnavailable } from '../src/samples'
import { failureText } from './harness'

const kick = Sha256('89'.repeat(32))

const sound = (channels: ReadonlyArray<Float32Array>): SamplePcm => ({ sampleRate: 48_000, channels })

/** A load that counts its runs. */
const counted = (pcm: () => SamplePcm) => {
  const runs = { count: 0 }
  const load = Effect.sync(() => {
    runs.count += 1
    return pcm()
  })
  return { load, runs }
}

const loaded = (channels: ReadonlyArray<Float32Array>) => Effect.succeed(sound(channels))

/** As a channel is once it went to the engine: its buffer is gone, and its length 0. */
const handedOver = (channel: Float32Array) => {
  structuredClone(channel.buffer, { transfer: [channel.buffer] })
  return channel
}

const pong: Pong = { _tag: 'Pong' }

/**
 * A build thread on the other end of a real channel, so the sound crosses as it does to a worker. It answers each
 * sound with `answer`, or not at all. `settled` ends once all that either end sent before has arrived.
 */
const buildThread = (answer?: (sound: StoreSample) => FromBuildThread) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const { port1: page, port2: thread } = new MessageChannel()
      const received: Array<SampleMessage> = []
      thread.addEventListener('message', ({ data }: MessageEvent<SampleMessage | Ping>) =>
        Match.valueTags(data, {
          Ping: () => thread.postMessage(pong),
          EvictSample: (evict) => {
            received.push(evict)
          },
          StoreSample: (sound) => {
            received.push(sound)
            Option.match(Option.fromUndefinedOr(answer), {
              onNone: () => {},
              onSome: (answering) => thread.postMessage(answering(sound))
            })
          }
        })
      )
      thread.start()
      page.start()
      // Answered after everything either end sent before: a channel keeps the order.
      const settled = answered(page)
      /** Once the build thread got `count` messages. */
      const arrived = (count: number) => settled.pipe(Effect.repeat({ until: () => received.length >= count }))
      return { page, thread, received, settled, arrived }
    }),
    ({ page, thread }) =>
      Effect.sync(() => {
        page.close()
        thread.close()
      })
  )

const stored = ({ id }: StoreSample): FromBuildThread => ({ _tag: 'SampleStored', id })

/** Each test's bound: the channel answers within a turn or two. */
const quick = 1000

/** Stores the sound against a build thread that answers it, and returns what the build thread got. */
const sent = (pcm: SamplePcm) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { page, received } = yield* buildThread(stored)
      const { store } = yield* sampleStore(page, Effect.never)
      yield* store(kick, Effect.succeed(pcm))
      return received
    })
  )

const storeMessage = (id: number, channels: ReadonlyArray<Float32Array>): SampleMessage => ({
  _tag: 'StoreSample',
  id,
  hash: kick,
  sampleRate: 48_000,
  channels
})

describe('storing a sound from the page', { timeout: quick }, () => {
  it.effect('ends once the build thread says it is in', () =>
    Effect.gen(function* () {
      const received = yield* sent(sound([Float32Array.of(0.5, 0.25)]))
      expect(received).toEqual([storeMessage(1, [Float32Array.of(0.5, 0.25)])])
    })
  )

  it.effect('sends the sound’s own fields only, whatever else its object has', () =>
    Effect.gen(function* () {
      const withMore = { ...sound([Float32Array.of(0.5)]), _tag: 'Batch', id: 7, hash: 'not for the engine' }
      const received = yield* sent(withMore)
      expect(received).toEqual([storeMessage(1, [Float32Array.of(0.5)])])
    })
  )

  it.effect('fails with the reason the engine refused it for', () =>
    Effect.gen(function* () {
      const exit = yield* Effect.scoped(
        Effect.gen(function* () {
          const { page } = yield* buildThread(({ id }) => ({ _tag: 'SampleRefused', id, reason: 'InvalidValue' }))
          const { store } = yield* sampleStore(page, Effect.never)
          return yield* Effect.exit(store(kick, loaded([Float32Array.of(Number.NaN)])))
        })
      )
      expect(exit).toEqual(Exit.fail(new SampleRefused({ reason: 'InvalidValue' })))
    })
  )

  it.effect('hands over a channel that is a whole buffer of its own, without a copy', () =>
    Effect.gen(function* () {
      const left = Float32Array.of(1, 2, 3)
      const right = Float32Array.of(4, 5, 6)
      const [received] = yield* sent(sound([left, right]))
      expect([left.buffer.byteLength, right.buffer.byteLength]).toEqual([0, 0])
      expect(received).toEqual(storeMessage(1, [Float32Array.of(1, 2, 3), Float32Array.of(4, 5, 6)]))
    })
  )

  it.effect('copies a channel that is part of a larger buffer, and leaves the buffer as it was', () =>
    Effect.gen(function* () {
      const planar = Float32Array.of(1, 2, 3, 4, 5, 6)
      const [received] = yield* sent(sound([planar.subarray(0, 3), planar.subarray(3)]))
      expect(planar).toEqual(Float32Array.of(1, 2, 3, 4, 5, 6))
      expect(received).toEqual(storeMessage(1, [Float32Array.of(1, 2, 3), Float32Array.of(4, 5, 6)]))
    })
  )

  it.effect('copies a channel in shared memory, and hands over the same channel twice', () =>
    Effect.gen(function* () {
      const shared = new Float32Array(new SharedArrayBuffer(8))
      shared.set([0.5, 0.25])
      const twice = Float32Array.of(1, 2)
      const [first, second] = [yield* sent(sound([shared])), yield* sent(sound([twice, twice]))]
      expect(shared).toEqual(Float32Array.of(0.5, 0.25))
      expect(first).toEqual([storeMessage(1, [Float32Array.of(0.5, 0.25)])])
      expect(second).toEqual([storeMessage(1, [Float32Array.of(1, 2), Float32Array.of(1, 2)])])
    })
  )

  it.effect.each([
    ['without a channel', [], /no channel/],
    ['with channels of different lengths', [Float32Array.of(1, 2), Float32Array.of(1)], /differ in length/],
    ['whose channel went over before', [handedOver(Float32Array.of(1, 2))], /went over to the engine before/]
  ] as const)('a sound %s is the caller’s bug: it dies, and nothing is sent', ([_, channels, message]) =>
    Effect.gen(function* () {
      const { exit, received } = yield* Effect.scoped(
        Effect.gen(function* () {
          const { page, received } = yield* buildThread(stored)
          const { store } = yield* sampleStore(page, Effect.never)
          return { exit: yield* Effect.exit(store(kick, loaded(channels))), received }
        })
      )
      expect(Exit.isFailure(exit) && Exit.hasDies(exit)).toBe(true)
      expect(failureText(exit)).toMatch(message)
      expect(received).toEqual([])
    })
  )

  it.effect('fails with the build thread when it fails while a sound waits', () =>
    Effect.gen(function* () {
      const exit = yield* Effect.scoped(
        Effect.gen(function* () {
          const { page } = yield* buildThread()
          const failed = yield* Deferred.make<never, BuildThreadError>()
          const { store } = yield* sampleStore(page, Deferred.await(failed))
          const storing = yield* Effect.forkChild(store(kick, loaded([Float32Array.of(0.5)])))
          yield* Deferred.fail(failed, new BuildThreadError({ message: 'gone' }))
          return yield* Fiber.await(storing)
        })
      )
      expect(exit).toEqual(Exit.fail(new BuildThreadError({ message: 'gone' })))
    })
  )

  it.effect('the engine stopping interrupts a sound that waits, and any sound after', () =>
    Effect.gen(function* () {
      const { waited, after } = yield* Effect.scoped(
        Effect.gen(function* () {
          const { page } = yield* buildThread()
          const engine = yield* Scope.make()
          const { store } = yield* sampleStore(page, Effect.never).pipe(Scope.provide(engine))
          const storing = yield* Effect.forkChild(store(kick, loaded([Float32Array.of(0.5)])))
          yield* Effect.yieldNow
          yield* Scope.close(engine, Exit.void)
          return {
            waited: yield* Fiber.await(storing),
            after: yield* Effect.exit(store(kick, loaded([Float32Array.of(0.5)])))
          }
        })
      )
      expect(Exit.hasInterrupts(waited)).toBe(true)
      expect(Exit.hasInterrupts(after)).toBe(true)
    })
  )
})

describe('the sounds the engine has', { timeout: quick }, () => {
  it.effect('a sound the engine has is neither loaded nor sent again', () =>
    Effect.gen(function* () {
      const { runs, received } = yield* Effect.scoped(
        Effect.gen(function* () {
          const { page, received } = yield* buildThread(stored)
          const { store } = yield* sampleStore(page, Effect.never)
          const { load, runs } = counted(() => sound([Float32Array.of(0.5)]))
          yield* store(kick, load)
          yield* store(kick, load)
          return { runs, received }
        })
      )
      expect(runs.count).toBe(1)
      expect(received).toHaveLength(1)
    })
  )

  it.effect('stores of a sound on its way wait for its one load and its one answer', () =>
    Effect.gen(function* () {
      const { runs, received, exits } = yield* Effect.scoped(
        Effect.gen(function* () {
          const { page, received } = yield* buildThread(({ id }) => ({
            _tag: 'SampleRefused',
            id,
            reason: 'InvalidValue'
          }))
          const { store } = yield* sampleStore(page, Effect.never)
          const { load, runs } = counted(() => sound([Float32Array.of(Number.NaN)]))
          const exits = yield* Effect.all([Effect.exit(store(kick, load)), Effect.exit(store(kick, load))], {
            concurrency: 'unbounded'
          })
          return { runs, received, exits }
        })
      )
      expect(runs.count).toBe(1)
      expect(received).toHaveLength(1)
      expect(exits).toEqual([0, 1].map(() => Exit.fail(new SampleRefused({ reason: 'InvalidValue' }))))
    })
  )

  it.effect.each([
    ['the engine refused it', Effect.succeed(sound([Float32Array.of(Number.NaN)])), 1],
    ['its load failed', Effect.fail(new SampleUnavailable({ message: 'gone' })), 0]
  ] as const)('a sound is loaded again once %s', ([_, first, messages]) =>
    Effect.gen(function* () {
      const { runs, received, failed } = yield* Effect.scoped(
        Effect.gen(function* () {
          const { page, received } = yield* buildThread(
            ({ id }): FromBuildThread =>
              Boolean.match(id === 1 && messages === 1, {
                onTrue: () => ({ _tag: 'SampleRefused', id, reason: 'InvalidValue' }),
                onFalse: () => ({ _tag: 'SampleStored', id })
              })
          )
          const { store } = yield* sampleStore(page, Effect.never)
          const failed = yield* Effect.exit(store(kick, first))
          const { load, runs } = counted(() => sound([Float32Array.of(0.5)]))
          yield* store(kick, load)
          return { runs, received, failed }
        })
      )
      expect(Exit.isFailure(failed)).toBe(true)
      expect(runs.count).toBe(1)
      expect(received).toHaveLength(messages + 1)
    })
  )

  it.effect('a failed load ends every store that waits for it with its error', () =>
    Effect.gen(function* () {
      const exits = yield* Effect.scoped(
        Effect.gen(function* () {
          const { page } = yield* buildThread(stored)
          const { store } = yield* sampleStore(page, Effect.never)
          const gate = yield* Deferred.make<SamplePcm, SampleUnavailable>()
          const waiting = yield* Effect.forkChild(
            Effect.all([Effect.exit(store(kick, Deferred.await(gate))), Effect.exit(store(kick, loaded([])))], {
              concurrency: 'unbounded'
            })
          )
          yield* Effect.yieldNow
          yield* Deferred.fail(gate, new SampleUnavailable({ message: 'gone' }))
          return yield* Fiber.join(waiting)
        })
      )
      expect(exits).toEqual([0, 1].map(() => Exit.fail(new SampleUnavailable({ message: 'gone' }))))
    })
  )

  it.effect('a store that stops waiting leaves the sound on its way, for the stores after', () =>
    Effect.gen(function* () {
      const { runs, received } = yield* Effect.scoped(
        Effect.gen(function* () {
          const { page, received } = yield* buildThread(stored)
          const { store } = yield* sampleStore(page, Effect.never)
          const gate = yield* Deferred.make<void>()
          const first = counted(() => sound([Float32Array.of(0.5)]))
          const second = counted(() => sound([Float32Array.of(0.5)]))
          const waiting = yield* Effect.forkChild(store(kick, Deferred.await(gate).pipe(Effect.andThen(first.load))))
          yield* Effect.yieldNow
          yield* Fiber.interrupt(waiting)
          yield* Deferred.succeed(gate, undefined)
          yield* store(kick, second.load)
          return { runs: [first.runs.count, second.runs.count], received }
        })
      )
      expect(runs).toEqual([1, 0])
      expect(received).toHaveLength(1)
    })
  )

  it.effect('another engine has none of them', () =>
    Effect.gen(function* () {
      const runs = yield* Effect.scoped(
        Effect.gen(function* () {
          const { page } = yield* buildThread(stored)
          const { load, runs } = counted(() => sound([Float32Array.of(0.5)]))
          const first = yield* Scope.make()
          const before = yield* sampleStore(page, Effect.never).pipe(Scope.provide(first))
          yield* before.store(kick, load)
          yield* Scope.close(first, Exit.void)
          const after = yield* sampleStore(page, Effect.never)
          yield* after.store(kick, load)
          return runs
        })
      )
      expect(runs.count).toBe(2)
    })
  )
})

describe('evicting a sound', { timeout: quick }, () => {
  it.effect('tells the build thread, and the next store loads and sends it again', () =>
    Effect.gen(function* () {
      const { evicted, runs, received } = yield* Effect.scoped(
        Effect.gen(function* () {
          const { page, received } = yield* buildThread(stored)
          const { store, evict } = yield* sampleStore(page, Effect.never)
          const { load, runs } = counted(() => sound([Float32Array.of(0.5)]))
          yield* store(kick, load)
          const evicted = evict(kick)
          yield* store(kick, load)
          return { evicted, runs, received }
        })
      )
      expect(evicted).toBe(true)
      expect(runs.count).toBe(2)
      expect(received).toEqual([
        storeMessage(1, [Float32Array.of(0.5)]),
        { _tag: 'EvictSample', hash: kick },
        storeMessage(2, [Float32Array.of(0.5)])
      ])
    })
  )

  it.effect('of a sound the engine has neither got nor is getting does nothing', () =>
    Effect.gen(function* () {
      const { evicted, received } = yield* Effect.scoped(
        Effect.gen(function* () {
          const { page, received, settled } = yield* buildThread(stored)
          const { evict } = yield* sampleStore(page, Effect.never)
          const evicted = evict(kick)
          yield* settled
          return { evicted, received }
        })
      )
      expect(evicted).toBe(false)
      expect(received).toEqual([])
    })
  )

  it.effect('while it loads interrupts the load and its stores, and sends nothing', () =>
    Effect.gen(function* () {
      const { evicted, waited, loadInterrupted, received } = yield* Effect.scoped(
        Effect.gen(function* () {
          const { page, received, settled } = yield* buildThread(stored)
          const { store, evict } = yield* sampleStore(page, Effect.never)
          const interrupted = { load: false }
          const load = Effect.never.pipe(
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                interrupted.load = true
              })
            )
          )
          const storing = yield* Effect.forkChild(store(kick, load))
          yield* Effect.yieldNow
          const evicted = evict(kick)
          const waited = yield* Fiber.await(storing)
          yield* settled
          // Read before the engine stops, which interrupts every load.
          return { evicted, waited, loadInterrupted: interrupted.load, received }
        })
      )
      expect(evicted).toBe(true)
      expect(Exit.hasInterrupts(waited)).toBe(true)
      expect(loadInterrupted).toBe(true)
      expect(received).toEqual([])
    })
  )

  it.effect('sent and not yet answered interrupts its stores, and its answer completes nothing after', () =>
    Effect.gen(function* () {
      const { waited, stores, received } = yield* Effect.scoped(
        Effect.gen(function* () {
          const { page, thread, received, settled, arrived } = yield* buildThread()
          const { store, evict } = yield* sampleStore(page, Effect.never)
          const storing = yield* Effect.forkChild(store(kick, loaded([Float32Array.of(0.5)])))
          yield* arrived(1)
          evict(kick)
          const waited = yield* Fiber.await(storing)
          const again = yield* Effect.forkChild(store(kick, loaded([Float32Array.of(0.25)])))
          yield* arrived(3)
          // The answer to the first sound, late.
          thread.postMessage({ _tag: 'SampleStored', id: 1 } satisfies FromBuildThread)
          yield* settled
          const stores = again.pollUnsafe()
          return { waited, stores, received }
        })
      )
      expect(Exit.hasInterrupts(waited)).toBe(true)
      expect(stores).toBeUndefined()
      expect(received).toEqual([
        storeMessage(1, [Float32Array.of(0.5)]),
        { _tag: 'EvictSample', hash: kick },
        storeMessage(2, [Float32Array.of(0.25)])
      ])
    })
  )
})
