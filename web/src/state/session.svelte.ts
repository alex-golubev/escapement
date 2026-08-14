// The page's side of a live engine: the handle a successful start produced, the
// parameters the page believes it has set, and the one function that reaches the
// audio thread.
//
// A module rather than a few `let`s in a component because of the rule the whole
// UI hangs from — there is exactly one write path into the engine, and it starts
// here. A `send` living in a component is a `send` that every later component
// has to be handed, and the first one that is not handed it will reach for the
// handle instead and open a second road. So the handle never leaves this file:
// what a component gets is readings and verbs, which makes a second road not
// something to avoid writing but something there is no way to write.
//
// `.svelte.ts` because the projection is runes. What a reactive scope reads has
// to be reactive, what an event handler reads does not — the fields below are
// read by a template, so they are state; `stopFrames` is read by handlers alone,
// so it is a plain `let`.

import { describeStartFailure, startEngine } from '../audio/host'
import type { EngineHandle } from '../audio/host'
import type { Command } from '../audio/protocol'
import type { WorkletMessage } from '../audio/worklet-messages'

export type Status = 'idle' | 'starting' | 'running' | 'failed'

/** Where a fresh engine starts, mirroring `DEFAULT_BPM` in transport.rs. */
const ENGINE_DEFAULT_BPM = 120

/**
 * Run `tick` on every frame, and hand back the way to stop it.
 *
 * A parameter rather than `requestAnimationFrame` reached for directly, for the
 * same reason `openEngine` takes `EngineExports` rather than a module: under
 * Node there are no frames and no `AudioContext`, so every path in this file
 * would be a path no test could take.
 */
export type FrameLoop = (tick: () => void) => () => void

const browserFrames: FrameLoop = (tick) => {
  let frame = requestAnimationFrame(function next() {
    tick()
    frame = requestAnimationFrame(next)
  })
  return () => {
    cancelAnimationFrame(frame)
  }
}

/** What a session is driven by, so that a test can drive it by something else. */
export interface SessionDeps {
  readonly start?: typeof startEngine
  readonly frames?: FrameLoop
}

/**
 * The page's whole relationship with the audio thread. Readings to display,
 * verbs to act with, and no handle: see the note at the top of the file.
 */
export interface Session {
  readonly status: Status
  /** Why the engine is not running, when that is known. */
  readonly failure: string | null
  /** The first block the processor rendered, as it reported the size back. */
  readonly quantum: number | null
  /** Null until a start succeeds — both come from the running engine, not from here. */
  readonly sampleRate: number | null
  readonly protocolVersion: number | null
  readonly position: number
  readonly peakL: number
  readonly peakR: number
  readonly playing: boolean
  readonly bpm: number
  start(): Promise<void>
  /** Give the device back. The counterpart of `start`, and what every failure path uses. */
  stop(): void
  toggle(): void
  setBpm(bpm: number): void
}

export function createSession(deps: SessionDeps = {}): Session {
  const bringUp = deps.start ?? startEngine
  const frames = deps.frames ?? browserFrames

  /**
   * Everything a successful start produced, in one holder. Non-null exactly
   * while the page is driving a live engine, because `discard` below is the only
   * way it is ever emptied.
   *
   * `$state.raw` and not `$state`: Svelte proxies plain-object state, and this is
   * a plain object holding two more, so `commands.send` on every step of a fader
   * drag and `telemetry.read` on every frame would go through two proxy layers.
   * Nothing mutates the handle — it is replaced whole, which is what raw means.
   */
  let handle = $state.raw<EngineHandle | null>(null)
  let starting = $state(false)
  let failure = $state<string | null>(null)
  let quantum = $state<number | null>(null)

  // What the engine says about itself. Read per frame, not per quantum: at 48 kHz
  // it publishes 375 times a second and a screen shows 60. Sampling the newest
  // value is the whole point of a seqlock over a queue — nothing accumulates, and
  // nothing is missed that could have been displayed.
  let position = $state(0)
  let peakL = $state(0)
  let peakR = $state(0)

  // What the page believes about the transport. Believes, and does not know: the
  // engine holds the truth and nothing reads it back, so this is an open loop. It
  // is honest for controls that only ever move on a gesture.
  let playing = $state(false)
  let bpm = $state(ENGINE_DEFAULT_BPM)

  let stopFrames: (() => void) | null = null

  function readTelemetry(): void {
    const live = handle
    if (live === null) return
    const reading = live.telemetry.read()
    // Null is the writer having been mid-publish every time this looked, which is
    // not an error: the previous frame's numbers stand and the next frame is 16 ms
    // away.
    if (reading === null) return
    position = reading.position
    peakL = reading.peakL
    peakR = reading.peakR
  }

  /**
   * Give up whatever is running, with a reason or without one.
   *
   * Closing the context is the substantive part. A handle merely dropped leaves
   * the node rendering into `destination` with nothing left holding a reference
   * that could stop it — the page shows a failure while the metronome plays on,
   * and only a reload ends it.
   */
  function discard(reason: string | null): void {
    stopFrames?.()
    stopFrames = null

    const live = handle
    handle = null
    failure = reason
    // Both are beliefs about a thread that no longer exists, and nothing carries
    // a belief across: whatever comes back from here is a new engine at its own
    // defaults, which never heard any of this. Left standing, they would put a
    // tempo on screen that no engine is playing at.
    playing = false
    bpm = ENGINE_DEFAULT_BPM

    // Not awaited, and the rejection is dropped: the context is already
    // unreachable from this file, so there is nothing a failed close leaves for
    // anyone to do.
    void live?.context.close().catch(() => undefined)
  }

  async function start(): Promise<void> {
    // Refused rather than queued. The button that calls this is disabled while a
    // start is in flight, but `disabled` reaches the DOM a task later than a
    // second click can arrive — milestone 0 recorded automation clicking sooner
    // than a person can twice in one sitting — and two starts are two contexts,
    // both connected and both rendering.
    if (starting || handle !== null) return

    starting = true
    failure = null

    // No try/catch: `startEngine` reports every way it can fail as a value, so a
    // catch here could only ever hide a bug in it.
    const started = await bringUp({ onMessage: receive, onCrash: crashed })
    starting = false

    if (!started.ok) {
      // Not through `discard`: a start that failed closed its own context on the
      // way out, and there is no handle here to give up.
      failure = describeStartFailure(started.error)
      return
    }

    handle = started.value
    // Started here rather than woken by an effect that watches the handle. The
    // loop's life is exactly the handle's, and both are decided in this function
    // and in `discard`, so there is no dependency set left to get wrong. What
    // this replaces read the reader out of a second variable and woke on the
    // status beside it, and ran only because the two were assigned in one
    // particular order — swapping two lines would have stopped it for good, with
    // the numbers frozen and nothing to notice.
    stopFrames = frames(readTelemetry)
  }

  /**
   * Every gesture goes through here, so the ring being full is diagnosed in one
   * place. It cannot happen while the worklet is draining — 1024 records against
   * one click — so when it does, the audio thread has stopped, and the fix is
   * nowhere near the control that reported it.
   */
  function send(command: Command): boolean {
    const live = handle
    // Two failures, and they are worth telling apart: no handle at all means this
    // ran while the page was not driving anything — unreachable through a
    // template that hides the controls, and a different fault with a different fix
    // from the ring being full.
    if (live === null) {
      discard('No engine to send to: the transport was used before the page had one')
      return false
    }
    if (live.commands.send(command)) return true
    discard('The command ring is full: the audio thread has stopped draining it')
    return false
  }

  function receive(message: WorkletMessage): void {
    if (message.type === 'first-quantum') quantum = message.frames
  }

  function crashed(): void {
    discard(
      'The audio thread stopped: a panic ends the worklet outright, and this one is gone. ' +
        'Starting again builds a new one',
    )
  }

  return {
    get status(): Status {
      // Computed rather than assigned beside the fields it reads, which would be
      // the same ordering trap one level up.
      return failure !== null
        ? 'failed'
        : handle !== null
          ? 'running'
          : starting
            ? 'starting'
            : 'idle'
    },
    get failure(): string | null {
      return failure
    },
    get quantum(): number | null {
      return quantum
    },
    get sampleRate(): number | null {
      return handle?.sampleRate ?? null
    },
    get protocolVersion(): number | null {
      return handle?.protocolVersion ?? null
    },
    get position(): number {
      return position
    },
    get peakL(): number {
      return peakL
    },
    get peakR(): number {
      return peakR
    },
    get playing(): boolean {
      return playing
    },
    get bpm(): number {
      return bpm
    },
    start,
    stop(): void {
      discard(null)
    },
    toggle(): void {
      if (send({ op: playing ? 'stop' : 'play' })) playing = !playing
    },
    setBpm(next: number): void {
      bpm = next
      send({ op: 'set-bpm', bpm: next })
    },
  }
}
