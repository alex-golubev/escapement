import { expect, it } from '@effect/vitest'
import { Boolean, Effect, Fiber } from 'effect'
import { type Answering, answered } from '../src/ping'
import type { Ping } from '../src/protocol'

/** Answers each ping on its next turn, after a message of another kind, unless it hangs; counts its listeners. */
const thread = (hangs: boolean) => {
  const target = new EventTarget()
  const listeners = new Set<unknown>()
  const answering: Answering = {
    addEventListener: (type, listener) => {
      listeners.add(listener)
      target.addEventListener(type, listener as EventListener)
    },
    removeEventListener: (type, listener) => {
      listeners.delete(listener)
      target.removeEventListener(type, listener as EventListener)
    },
    postMessage: (_: Ping) =>
      Boolean.match(hangs, {
        onTrue: () => {},
        onFalse: () =>
          queueMicrotask(() => {
            target.dispatchEvent(new MessageEvent('message', { data: { _tag: 'SampleStored', id: 1 } }))
            target.dispatchEvent(new MessageEvent('message', { data: { _tag: 'Pong' } }))
          })
      })
  }
  return { answering, listeners: () => listeners.size }
}

it.effect('a ping ends at the answer and leaves no listener behind, answered or given up', () =>
  Effect.gen(function* () {
    const there = thread(false)
    yield* Effect.replicateEffect(answered(there.answering), 3, { discard: true })
    expect(there.listeners()).toBe(0)

    const hung = thread(true)
    const waiting = yield* Effect.forkChild(answered(hung.answering), { startImmediately: true })
    expect(hung.listeners()).toBe(1)
    yield* Fiber.interrupt(waiting)
    expect(hung.listeners()).toBe(0)
  })
)
