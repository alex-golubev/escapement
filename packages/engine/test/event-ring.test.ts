import { expect, it } from '@effect/vitest'
import { Effect, Fiber, Stream } from 'effect'
import { DeviceEdit } from '../src/device-edits'
import { eventStream } from '../src/event-ring'
import type { EngineEvent } from '../src/events'
import { failureText, missingNode, rejected, startEngine, type TestEngine } from './harness'

const listen = (events: Stream.Stream<EngineEvent>, count: number) => events.pipe(Stream.take(count), Stream.runCollect)

// On the real clock: the ring is polled on it.
const run = <A>(program: Effect.Effect<A>) => program.pipe(Effect.timeout('1 second'))

/** Polled every millisecond so the tests don't wait. */
const withEvents = <A>(use: (engine: TestEngine, events: Stream.Stream<EngineEvent>) => Effect.Effect<A>) =>
  Effect.gen(function* () {
    const engine = startEngine()
    return yield* use(engine, yield* eventStream(engine.eventRing, '1 millis'))
  })

/** Has the engine reject a command in session `epoch`. */
const rejectIn = (engine: TestEngine, epoch: number) =>
  Effect.sync(() => {
    engine.send({ edits: [DeviceEdit.Reset({ epoch })], commands: [missingNode] })
    engine.peak()
  })

it.live('events that waited in the ring reach the listener', () =>
  Effect.gen(function* () {
    const heard = yield* run(
      withEvents((engine, events) => rejectIn(engine, 1).pipe(Effect.andThen(listen(events, 1))))
    )
    expect(heard).toEqual([rejected('UnknownTarget', 1)])
  })
)

it.live('events the listener did not take stay in the ring for the next one', () =>
  Effect.gen(function* () {
    const heard = yield* run(
      withEvents((engine, events) =>
        Effect.gen(function* () {
          yield* rejectIn(engine, 1)
          yield* rejectIn(engine, 2)
          return [yield* listen(events, 1), yield* listen(events, 1)]
        })
      )
    )
    expect(heard).toEqual([[rejected('UnknownTarget', 1)], [rejected('UnknownTarget', 2)]])
  })
)

it.live('the listener hears events that come while it waits', () =>
  Effect.gen(function* () {
    const heard = yield* run(
      withEvents((engine, events) =>
        Effect.gen(function* () {
          const listener = yield* Effect.forkChild(listen(events, 1))
          yield* Effect.sleep('20 millis')
          yield* rejectIn(engine, 1)
          return yield* Fiber.join(listener)
        })
      )
    )
    expect(heard).toEqual([rejected('UnknownTarget', 1)])
  })
)

it.live('a second listener at the same time is a bug', () =>
  Effect.gen(function* () {
    const second = yield* Effect.exit(
      run(
        withEvents((_, events) =>
          Effect.gen(function* () {
            yield* Effect.forkChild(listen(events, 1))
            yield* Effect.sleep('10 millis')
            return yield* listen(events, 1)
          })
        )
      )
    )
    expect(failureText(second)).toMatch(/already have a listener/)
  })
)
