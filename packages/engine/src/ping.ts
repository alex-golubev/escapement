import { Boolean, Effect, Predicate } from 'effect'
import type { Ping } from './protocol'

const ping: Ping = { _tag: 'Ping' }

/** Where a thread's answers come from and its pings go. */
export interface Answering {
  readonly addEventListener: (type: 'message', listener: (event: MessageEvent) => void) => void
  readonly removeEventListener: (type: 'message', listener: (event: MessageEvent) => void) => void
  readonly postMessage: (message: Ping) => void
  /** A port gives its listeners nothing until started. */
  readonly start?: () => void
}

/** Pings the thread; ends at its next answer. Either way, answered or interrupted, its listener goes. */
export const answered = (thread: Answering): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    // Other messages share the channel.
    const onMessage = ({ data }: MessageEvent) =>
      Boolean.match(Predicate.isTagged(data, 'Pong'), {
        onFalse: () => {},
        onTrue: () => {
          thread.removeEventListener('message', onMessage)
          resume(Effect.void)
        }
      })
    thread.addEventListener('message', onMessage)
    thread.start?.()
    thread.postMessage(ping)
    return Effect.sync(() => thread.removeEventListener('message', onMessage))
  })
