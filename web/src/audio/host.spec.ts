// Bring-up as seen from the page. Everything here is a failure path, and they
// share a property that makes them worth pinning: from the outside they are
// all the same event — no sound — while each has a different fix. The one
// thing a test cannot reach is `startEngine` itself, which needs an
// `AudioContext`; what it wraps is reachable, and that is where the failures
// are decided.

import { describe, expect, it, vi } from 'vitest'

import { unwrapError, unwrapValue } from '../../tests/support/unwrap'
import { awaitReady, describeStartFailure } from './host'
import type { ReadyEndpoint, StartFailure } from './host'
import type { WorkletMessage } from './worklet-messages'

const TIMEOUT_MS = 5000

const READY: WorkletMessage = { type: 'ready', sampleRate: 44100, protocolVersion: 1 }

describe('awaitReady', () => {
  it('settles on the ready message the processor posts from its constructor', async () => {
    const endpoint = fakeEndpoint()
    const pending = awaitReady(endpoint.node, undefined, TIMEOUT_MS)

    endpoint.post(READY)
    expect(unwrapValue(await pending)).toEqual(READY)
  })

  it('carries the processor’s own reason through unchanged', async () => {
    // The reason crossed a thread boundary to get here. Rewording it on the
    // way out would lose the only description of what actually went wrong.
    const endpoint = fakeEndpoint()
    const pending = awaitReady(endpoint.node, undefined, TIMEOUT_MS)

    endpoint.post({ type: 'failed', message: 'Protocol mismatch: the engine reports 2' })
    expect(unwrapError(await pending)).toEqual({
      kind: 'processor-failed',
      message: 'Protocol mismatch: the engine reports 2',
    })
  })

  it('reports a crash that happened before the processor could describe it', async () => {
    const endpoint = fakeEndpoint()
    const pending = awaitReady(endpoint.node, undefined, TIMEOUT_MS)

    endpoint.crash()
    expect(unwrapError(await pending).kind).toBe('processor-crashed')
  })

  it('gives up on a processor that says nothing at all', async () => {
    // Without this the promise stays pending forever and the UI sits on
    // "Starting…" — a failure with no message, no log and no end.
    vi.useFakeTimers()
    try {
      const pending = awaitReady(fakeEndpoint().node, undefined, TIMEOUT_MS)
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS)
      expect(unwrapError(await pending)).toEqual({ kind: 'processor-silent', ms: TIMEOUT_MS })
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops the timeout once the answer is in', async () => {
    // A timer left running holds the page awake for whatever it has left, and
    // on a five-second bound that is five seconds of a process that has
    // already finished starting.
    vi.useFakeTimers()
    try {
      const endpoint = fakeEndpoint()
      const pending = awaitReady(endpoint.node, undefined, TIMEOUT_MS)
      expect(vi.getTimerCount()).toBe(1)

      endpoint.post(READY)
      await pending
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps listening after ready, because first-quantum arrives later', async () => {
    // The one behaviour that looked like a leaked callback and is not: the
    // handler outliving the promise is what delivers every later message.
    const endpoint = fakeEndpoint()
    const seen: WorkletMessage[] = []
    const pending = awaitReady(endpoint.node, (message) => seen.push(message), TIMEOUT_MS)

    endpoint.post(READY)
    await pending
    endpoint.post({ type: 'first-quantum', frames: 128 })

    expect(seen).toEqual([READY, { type: 'first-quantum', frames: 128 }])
  })

  it('lets a late message stand without overturning the verdict', async () => {
    vi.useFakeTimers()
    try {
      const endpoint = fakeEndpoint()
      const pending = awaitReady(endpoint.node, undefined, TIMEOUT_MS)
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS)

      endpoint.post(READY)
      expect(unwrapError(await pending).kind).toBe('processor-silent')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('describeStartFailure', () => {
  it('has a distinct, non-empty message for every way starting can fail', () => {
    // Keyed by the union: a new failure case fails to compile here until it is
    // given a sample, and `describeStartFailure` has no default branch, so it
    // fails to compile too.
    const samples: Record<StartFailure['kind'], StartFailure> = {
      'context-unavailable': { kind: 'context-unavailable', message: 'no device' },
      'wasm-unavailable': { kind: 'wasm-unavailable', message: '404' },
      'worklet-unavailable': { kind: 'worklet-unavailable', message: '404' },
      'node-unavailable': { kind: 'node-unavailable', message: 'NotSupportedError' },
      'processor-failed': { kind: 'processor-failed', message: 'engine_new refused' },
      'processor-crashed': { kind: 'processor-crashed' },
      'processor-silent': { kind: 'processor-silent', ms: TIMEOUT_MS },
      'context-suspended': { kind: 'context-suspended', state: 'suspended' },
    }

    const messages = Object.values(samples).map(describeStartFailure)
    expect(messages.every((message) => message.length > 0)).toBe(true)
    expect(new Set(messages).size).toBe(messages.length)
  })

  it('names the script that rebuilds whichever artifact is missing', () => {
    // The two artifacts are produced by different scripts, which is the whole
    // reason the two loads are told apart rather than joined into one failure.
    expect(describeStartFailure({ kind: 'wasm-unavailable', message: '404' })).toContain(
      'build-wasm.sh',
    )
    expect(describeStartFailure({ kind: 'worklet-unavailable', message: '404' })).toContain(
      'build:worklet',
    )
  })
})

function fakeEndpoint() {
  const node: ReadyEndpoint = { port: { onmessage: null }, onprocessorerror: null }
  return {
    node,
    post: (message: WorkletMessage) =>
      node.port.onmessage?.({ data: message } as MessageEvent<WorkletMessage>),
    // The handler ignores its argument — the event carries no reason at all,
    // which is the whole reason `processor-crashed` has no message field. A
    // plain Event stands in because `ErrorEvent` is not a global under Node.
    crash: () => node.onprocessorerror?.(new Event('processorerror') as ErrorEvent),
  }
}
