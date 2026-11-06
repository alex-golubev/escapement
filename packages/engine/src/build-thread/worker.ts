import type { BuildThreadReady, BuildThreadStart, Pong, ToBuildThread } from '../protocol'
import { type BatchBuilder, buildEngine } from './build-engine'
import { type Schedule, sampleQueue } from './sample-queue'

/** How often returned parcels are freed while any are out. */
const collectEveryMs = 50

const pong: Pong = { _tag: 'Pong' }

// Anything thrown here reaches the page as the worker's `error` event.
self.addEventListener('messageerror', () => {
  throw new Error('The build thread could not read a message from the page')
})

/** Frees returned parcels until none are out, with one timer at a time. */
const collector = (builder: BatchBuilder) => {
  const timer = { pending: false }
  const collectLater = (out: number) => {
    if (out === 0 || timer.pending) return
    timer.pending = true
    setTimeout(() => {
      timer.pending = false
      collectLater(builder.collect())
    }, collectEveryMs)
  }
  return collectLater
}

/** A task per step through a channel of its own: a nested `setTimeout` would wait 4 ms each. */
const taskSchedule = (): Schedule => {
  const { port1, port2 } = new MessageChannel()
  const steps: Array<() => void> = []
  port1.addEventListener('message', () => steps.shift()?.())
  port1.start()
  return (step) => {
    steps.push(step)
    port2.postMessage(undefined)
  }
}

self.addEventListener(
  'message',
  ({ data }: MessageEvent<BuildThreadStart>) => {
    const { engine, builder, samples } = buildEngine(data)
    const collectLater = collector(builder)
    collectLater(builder.collect())
    const queue = sampleQueue(samples, taskSchedule(), (answer) => self.postMessage(answer))
    // Sounds in the order the page sent them; a sound's parts leave room for batches and answers between.
    self.addEventListener('message', ({ data }: MessageEvent<ToBuildThread>) => {
      if (data._tag === 'Batch') collectLater(builder.build(data))
      else if (data._tag === 'Ping') self.postMessage(pong)
      else queue(data)
    })
    const ready: BuildThreadReady = { _tag: 'Ready', engine }
    self.postMessage(ready)
  },
  { once: true }
)
