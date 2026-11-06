import { type Duration, Effect, Schedule } from 'effect'
import { CommandStreamError } from './errors'
import type { Telemetry } from './telemetry'

/** As often as the page looks for events: a lost stream is noticed as soon as the event about it would be. */
const lookEvery: Duration.Input = '50 millis'

/** Fails once the board says the engine lost its command stream; never succeeds. */
export const lostStream = (read: () => Telemetry | undefined): Effect.Effect<never, CommandStreamError> =>
  Effect.sync(() => read()?.streamLost === true).pipe(
    Effect.repeat({ until: (lost) => lost, schedule: Schedule.spaced(lookEvery) }),
    Effect.flatMap(() => Effect.fail(new CommandStreamError({ message: 'The engine lost its command stream' })))
  )
