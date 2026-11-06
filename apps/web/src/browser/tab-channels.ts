import { Effect, Layer } from 'effect'
import { TabChannels } from '../services/tab-sync'

/** Through `BroadcastChannel`, which carries a message to every other tab of the site on the same name. */
export const tabChannelsLayer = Layer.succeed(TabChannels, {
  open: (name) =>
    Effect.map(
      Effect.acquireRelease(
        Effect.sync(() => new BroadcastChannel(name)),
        (channel) => Effect.sync(() => channel.close())
      ),
      (channel) => ({
        post: (message) => channel.postMessage(message),
        listen: (heard) => {
          const onMessage = ({ data }: MessageEvent<unknown>) => heard(data)
          channel.addEventListener('message', onMessage)
          return () => channel.removeEventListener('message', onMessage)
        }
      })
    )
})
