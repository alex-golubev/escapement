// The page's state layer, which until it left App.svelte no test could reach at
// all: a component holds its state inside itself, and half of what is below is a
// failure path that needs an engine to fail on demand.
//
// Nothing here is simulated except the two things Node does not have — the
// bring-up and the frame clock — and both are parameters for exactly that
// reason. The rig at the bottom is local to this file: it has one consumer, and
// a fake with one consumer belongs beside it.

import { describe, expect, it } from 'vitest'

import { createSession } from './session.svelte'
import type { FrameLoop } from './session.svelte'
import type { EngineEvents, EngineHandle, StartFailure } from '../audio/host'
import type { Command } from '../audio/protocol'
import type { Telemetry } from '../audio/telemetry'
import type { WorkletMessage } from '../audio/worklet-messages'

/** Not 48000, and not 3: numbers the engine reports are not numbers the page knows. */
const SAMPLE_RATE = 44_100
const PROTOCOL_VERSION = 7

describe('createSession', () => {
  it('starts idle, driving nothing', () => {
    const { session } = rig()

    expect(session.status).toBe('idle')
    expect(session.failure).toBeNull()
    expect(session.sampleRate).toBeNull()
    expect(session.protocolVersion).toBeNull()
  })

  it('reports a start in flight before it reports an engine', async () => {
    // The button reads this to disable itself. A status that only moved on
    // success would leave it live through the whole of `addModule`.
    const held = rig({ hold: true })

    const starting = held.session.start()
    expect(held.session.status).toBe('starting')

    held.release()
    await starting
    expect(held.session.status).toBe('running')
  })

  it('carries the engine’s own numbers rather than the page’s assumptions', async () => {
    // The context settles on a rate of its own choosing and the version came out
    // of the compiled wasm. Both are readings, not constants, which is why they
    // are null until there is something to read them from.
    const { session } = rig()
    await session.start()

    expect(session.sampleRate).toBe(SAMPLE_RATE)
    expect(session.protocolVersion).toBe(PROTOCOL_VERSION)
  })

  it('describes a start that failed, and can be started again after one', async () => {
    // Every failure presents on the page as no sound, so the description is the
    // whole of what the user gets. Staying startable is the other half: a page
    // that reports a dead engine and takes the button away leaves a reload as
    // the only move.
    const harness = rig()
    harness.failNext({ kind: 'processor-silent', ms: 5000 })

    await harness.session.start()
    expect(harness.session.status).toBe('failed')
    expect(harness.session.failure).toContain('5000 ms')

    await harness.session.start()
    expect(harness.session.status).toBe('running')
    expect(harness.session.failure).toBeNull()
  })

  it('does not close a context that a failed start has already closed', async () => {
    // `startEngine` releases the context on its own way out — that is the one
    // shape `acquireRelease` does not give you, and it is argued in host.ts.
    // Closing again here would be this file assuming a failed start left
    // something behind.
    const harness = rig()
    harness.failNext({ kind: 'context-suspended', state: 'suspended' })

    await harness.session.start()
    expect(harness.closes()).toBe(0)
  })

  it('reads telemetry once a frame, and holds the last reading when the writer was mid-publish', async () => {
    // A null reading is the seqlock refusing, not an error. Zeroing the display
    // on it would make the meters flicker against a perfectly healthy engine.
    const harness = rig()
    await harness.session.start()

    harness.publish({ position: 4096, peakL: 0.5, peakR: 0.25 })
    harness.frame()
    expect(harness.session.position).toBe(4096)

    harness.publish(null)
    harness.frame()
    expect(harness.session.position).toBe(4096)
    expect(harness.session.peakL).toBe(0.5)
  })

  it('gives the device back on stop, and stops reading with it', async () => {
    // The substantive half of stopping. A handle merely dropped leaves the node
    // rendering into `destination` with nothing left holding a reference that
    // could stop it: the page goes quiet and the metronome does not.
    const harness = rig()
    await harness.session.start()
    expect(harness.reading()).toBe(true)

    harness.session.stop()

    expect(harness.closes()).toBe(1)
    expect(harness.reading(), 'the frame loop outlived the engine').toBe(false)
    expect(harness.session.status).toBe('idle')
    expect(harness.session.failure).toBeNull()
  })

  it('closes the context when the audio thread dies under it', async () => {
    // `panic = "abort"` leaves the worklet gone and the context open. Nothing
    // else on the page moves when this happens, so the report and the teardown
    // both have to come from here.
    const harness = rig()
    await harness.session.start()

    harness.crash()

    expect(harness.session.status).toBe('failed')
    expect(harness.session.failure).toContain('panic')
    expect(harness.closes()).toBe(1)
    expect(harness.reading()).toBe(false)
  })

  it('refuses a second start while the first is still in flight', async () => {
    // `disabled` on the button reaches the DOM a task later than a second click
    // can arrive, and two starts are two contexts — both connected, both
    // rendering, and only one of them reachable afterwards.
    const harness = rig({ hold: true })

    const first = harness.session.start()
    const second = harness.session.start()
    expect(harness.starts()).toBe(1)

    harness.release()
    await Promise.all([first, second])
    expect(harness.starts()).toBe(1)
  })

  it('refuses a start while an engine is already running', async () => {
    const harness = rig()
    await harness.session.start()

    await harness.session.start()

    expect(harness.starts()).toBe(1)
  })

  it('sends play and stop, and believes only what was accepted', async () => {
    const harness = rig()
    await harness.session.start()

    harness.session.toggle()
    expect(harness.session.playing).toBe(true)
    harness.session.toggle()
    expect(harness.session.playing).toBe(false)

    expect(harness.sent()).toEqual([{ op: 'play' }, { op: 'stop' }])
  })

  it('sends the tempo of every step of a drag', async () => {
    // Not on release: a change that only lands when the pointer comes up cannot
    // show whether the change itself was seamless, which is what is being tested
    // by dragging it.
    const harness = rig()
    await harness.session.start()

    for (const bpm of [121, 122, 123]) harness.session.setBpm(bpm)

    expect(harness.session.bpm).toBe(123)
    expect(harness.sent()).toEqual([
      { op: 'set-bpm', bpm: 121 },
      { op: 'set-bpm', bpm: 122 },
      { op: 'set-bpm', bpm: 123 },
    ])
  })

  it('does not move the transport it failed to send', async () => {
    // The belief and the command are one gesture. A page that flipped to
    // "playing" on a command that never arrived would show a transport running
    // against silence, with nothing to say which of the two was wrong.
    const harness = rig()
    await harness.session.start()
    harness.refuse()

    harness.session.toggle()

    expect(harness.session.playing).toBe(false)
  })

  it('gives up the engine when the ring refuses a command', async () => {
    // Today a refusal means the far end stopped draining — 1024 records against
    // one gesture — so it is treated as the engine being gone. That stops being
    // true with the first caller that sends in bulk.
    const harness = rig()
    await harness.session.start()
    harness.refuse()

    harness.session.toggle()

    expect(harness.session.status).toBe('failed')
    expect(harness.session.failure).toContain('ring is full')
    expect(harness.closes()).toBe(1)
  })

  it('forgets what it believed once the engine is gone', async () => {
    // The next engine starts stopped and at its own default tempo, having heard
    // none of this. Carried over, the belief would offer to stop a transport
    // that never ran and would put a tempo on screen that nothing is playing at
    // — visible only to someone who compares the number against their ears.
    const harness = rig()
    await harness.session.start()
    harness.session.toggle()
    harness.session.setBpm(174)
    expect(harness.session.playing).toBe(true)

    harness.session.stop()
    await harness.session.start()

    expect(harness.session.playing).toBe(false)
    expect(harness.session.bpm).toBe(120)
  })

  it('reports the size of the first block the processor rendered', async () => {
    // The one number the native suite cannot observe: Web Audio specifies 128
    // and the page holds the reported value against it.
    const harness = rig()
    await harness.session.start()

    harness.post({ type: 'first-quantum', frames: 128 })

    expect(harness.session.quantum).toBe(128)
  })
})

/**
 * A session driven by a fake bring-up and a hand-cranked frame clock.
 *
 * `hold` keeps the start pending until `release`, which is the only way to
 * observe the window a second click can arrive in.
 */
function rig(options: { hold?: boolean } = {}) {
  let closes = 0
  let starts = 0
  let accept = true
  let reading: Telemetry | null = { position: 0, peakL: 0, peakR: 0 }
  let failure: StartFailure | null = null
  let events: EngineEvents = {}
  let tick: (() => void) | null = null
  const sent: Command[] = []

  let release = (): void => undefined
  const held = new Promise<void>((resolve) => {
    release = () => {
      resolve()
    }
  })

  const handle: EngineHandle = {
    context: {
      close: () => {
        closes += 1
        return Promise.resolve()
      },
    } as unknown as AudioContext,
    node: {} as unknown as AudioWorkletNode,
    sampleRate: SAMPLE_RATE,
    protocolVersion: PROTOCOL_VERSION,
    commands: {
      send: (command: Command) => {
        if (!accept) return false
        sent.push(command)
        return true
      },
      dropped: () => 0,
    },
    telemetry: { read: () => reading },
  }

  const frames: FrameLoop = (run) => {
    tick = run
    return () => {
      tick = null
    }
  }

  const session = createSession({
    frames,
    start: async (given: EngineEvents = {}) => {
      starts += 1
      events = given
      if (options.hold === true) await held
      // Consumed, so that `failNext` names one start rather than every one after
      // it — the retry after a failure is a case worth being able to write.
      const refusal = failure
      failure = null
      return refusal === null ? { ok: true, value: handle } : { ok: false, error: refusal }
    },
  })

  return {
    session,
    release: (): void => {
      release()
    },
    starts: () => starts,
    closes: () => closes,
    sent: () => sent,
    /** Whether the frame loop is running. */
    reading: () => tick !== null,
    frame: (): void => {
      if (tick === null) throw new Error('no frame loop is running')
      tick()
    },
    publish: (next: Telemetry | null): void => {
      reading = next
    },
    refuse: (): void => {
      accept = false
    },
    failNext: (next: StartFailure): void => {
      failure = next
    },
    crash: (): void => events.onCrash?.(),
    post: (message: WorkletMessage): void => events.onMessage?.(message),
  }
}
