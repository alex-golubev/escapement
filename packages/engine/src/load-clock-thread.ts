import { Data, Effect } from 'effect'
import clockThreadUrl from './clock-thread/worker.ts?worker&url'

export class LoadClockError extends Data.TaggedError('LoadClockError')<{ readonly cause: unknown }> {}

/** The load clock's thread until it fails, a core busy in its bursts: only while the page measures at all. */
export const loadClockThread = (clock: SharedArrayBuffer) =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* Effect.acquireRelease(
        Effect.try({
          try: () => new Worker(clockThreadUrl, { type: 'module', name: 'escapement-clock' }),
          catch: (cause) => new LoadClockError({ cause })
        }),
        (started) => Effect.sync(() => started.terminate())
      )
      thread.postMessage(clock)
      // A script that doesn't load tells only by its event.
      return yield* Effect.callback<never, LoadClockError>((resume) => {
        const failed = ({ message }: ErrorEvent) => resume(Effect.fail(new LoadClockError({ cause: message })))
        thread.addEventListener('error', failed)
        return Effect.sync(() => thread.removeEventListener('error', failed))
      })
    })
  )
