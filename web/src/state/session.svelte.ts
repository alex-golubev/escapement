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
import { browserKitSource, describeKitFailure, fetchKit } from '../audio/kit'
import type { KitFailure } from '../audio/kit'
import type { Command } from '../audio/protocol'
import type { Result } from '../audio/result'
import type { KitSample, WorkletMessage } from '../audio/worklet-messages'

export type Status = 'idle' | 'starting' | 'running' | 'failed'

/**
 * How far the kit has got.
 *
 * Beside `status` rather than folded into it, because the engine runs without
 * one: the metronome sounds, the transport moves, and only the pads are silent.
 * A kit that would not load is a reading, not the end of the session.
 */
export type KitStatus = 'none' | 'loading' | 'loaded' | 'failed'

/**
 * The tempo a page opens at, and nothing more than that.
 *
 * It was a mirror of `DEFAULT_BPM` in transport.rs while the engine was left to
 * start wherever it starts and the page merely displayed the same number. Two
 * defaults agreeing is not agreement — it is two answers that have not been
 * compared — and the number on screen was the one that could be wrong in
 * silence. The engine is told this now, so it is the page's own choice.
 */
const INITIAL_BPM = 120

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

/** Where a kit comes from. A parameter for the same reason `start` is. */
export type KitFetch = (
  context: BaseAudioContext,
) => Promise<Result<readonly KitSample[], KitFailure>>

/** What a session is driven by, so that a test can drive it by something else. */
export interface SessionDeps {
  readonly start?: typeof startEngine
  readonly frames?: FrameLoop
  readonly kit?: KitFetch
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
  /**
   * Commands the ring had no room for. Non-zero is a bug rather than a load
   * condition — 1024 records is some three seconds of gestures — and it is a
   * reading rather than a failure precisely so that it can be seen instead of
   * ending the session.
   */
  readonly dropped: number
  readonly peakL: number
  readonly peakR: number
  /**
   * Where the sequencer stands in the pattern, in steps and fractional — see
   * `Telemetry.step`. A number on screen for now: it is the grid that will draw
   * it, and the grid is not built yet.
   */
  readonly step: number
  readonly playing: boolean
  readonly bpm: number
  readonly metronome: boolean
  readonly kit: KitStatus
  /** Why the kit is not loaded, when that is known. */
  readonly kitFailure: string | null
  start(): Promise<void>
  /** Give the device back. The counterpart of `start`, and what every failure path uses. */
  stop(): void
  toggle(): void
  setBpm(bpm: number): void
  setMetronome(enabled: boolean): void
  /**
   * Strike a track outside the grid. Nothing is remembered afterwards, which is
   * what makes this the one verb here with no belief to keep in step: a pad
   * leaves no state behind, so there is nothing for the engine and this module
   * to disagree about.
   */
  trigger(track: number): void
}

export function createSession(deps: SessionDeps = {}): Session {
  const bringUp = deps.start ?? startEngine
  const frames = deps.frames ?? browserFrames
  // Built from the context that will play them, because that is what decides
  // the rate `decodeAudioData` resamples to.
  const collectKit = deps.kit ?? ((context) => fetchKit(browserKitSource(context)))

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
  let step = $state(0)

  // What the page believes about the transport. Believes, and does not know: the
  // engine holds the truth and nothing reads it back, so this is an open loop. It
  // is honest for controls that only ever move on a gesture.
  let playing = $state(false)
  let bpm = $state(INITIAL_BPM)
  // The engine comes up with the click on, and this page says so rather than
  // agreeing with it by coincidence — the argument is at `INITIAL_BPM`.
  let metronome = $state(true)

  // How the kit is getting on. `loading` covers both halves of the journey — the
  // fetch here and the load over there — because from the page they are one
  // wait, and only its end has two shapes.
  let kit = $state<KitStatus>('none')
  let kitFailure = $state<string | null>(null)

  // What the ring's own counter says, sampled where it can have changed. A tally
  // kept here beside it would be a second answer to one question, and the ring's
  // is the one the count actually lives in.
  let dropped = $state(0)

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
    step = reading.step
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
    // A belief about a thread that no longer exists. The tempo beside it is not
    // dropped and this one is, and the difference is what each is about: a tempo
    // is a setting the page holds and hands to whatever engine it has, while a
    // transport that has never been told to play is not playing — not by default
    // but by definition, so there is nothing here to carry over.
    playing = false
    // Same for the drops: the next engine comes with a ring of its own, and that
    // ring's counter starts at zero.
    dropped = 0
    // And the kit: it lived in an arena that goes with the engine. The tempo is
    // kept and this is not, by the same rule — a setting the page holds against
    // a reading of what the engine has.
    kit = 'none'
    kitFailure = null

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

    // The engine comes up holding defaults of its own, and what it plays has to
    // be what this page says rather than what those defaults happen to be. So
    // the settings go over before anything else does: with them sent, no number
    // on screen is a number the engine was never told, and the page stops being
    // able to display a tempo nothing is playing at.
    //
    // One command today and a list of them by the time there is a pattern to
    // send — this is the same path a project being opened will take, which is
    // why it is the ordinary write path and not something start does specially.
    send({ op: 'set-bpm', bpm })
    send({ op: 'set-metronome', enabled: metronome })

    // Started here rather than woken by an effect that watches the handle. The
    // loop's life is exactly the handle's, and both are decided in this function
    // and in `discard`, so there is no dependency set left to get wrong. What
    // this replaces read the reader out of a second variable and woke on the
    // status beside it, and ran only because the two were assigned in one
    // particular order — swapping two lines would have stopped it for good, with
    // the numbers frozen and nothing to notice.
    stopFrames = frames(readTelemetry)

    // Not awaited, and `start` resolves without it. The engine is running — the
    // transport moves and the metronome sounds — and holding the button on
    // "Starting…" through a fetch and a decode would report a device that is
    // already open as not yet open.
    void collect(started.value)
  }

  /**
   * Fetch a kit and hand it over. The answer to the second half comes back as a
   * message, so this ends while the load is still in flight.
   */
  async function collect(live: EngineHandle): Promise<void> {
    kit = 'loading'
    kitFailure = null

    const fetched = await collectKit(live.context)

    // The engine can be given back while a kit is in the air — a failed start
    // retried, or the stop button. Writing the outcome then would put a reading
    // about a dead engine on screen, and `kit` is one of the fields `discard`
    // has already cleared.
    if (handle !== live) return

    if (!fetched.ok) {
      kit = 'failed'
      kitFailure = describeKitFailure(fetched.error)
      return
    }

    // Stays `loading` until the worklet answers: what has happened so far is
    // that the page has the samples, which is not what the word is about.
    live.loadKit(fetched.value)
  }

  /**
   * Hand one command to the audio thread. The answer is whether it reached the
   * ring, and every caller below gates its own belief on it — which is what keeps
   * a refusal from leaving the page claiming a setting the engine never got.
   *
   * A refusal is not the engine failing and is not treated as one. The ring being
   * full says a command did not fit and nothing whatever about why: today the only
   * way to fill it is the far end having stopped draining — 1024 records against
   * one gesture — but that stops being true with the first caller that sends in
   * bulk, and a page that tore the engine down over it would be tearing it down
   * over a busy buffer. What the drop gets instead is the counter, which is the
   * one thing a drop must never do quietly.
   */
  function send(command: Command): boolean {
    const live = handle
    // Not the same fault: no handle at all means a control was used while the page
    // was driving nothing. Unreachable through a template that hides them, but
    // reachable through this module's own surface, and it is a bug here rather
    // than a full buffer over there.
    if (live === null) {
      discard('No engine to send to: the transport was used before the page had one')
      return false
    }
    if (live.commands.send(command)) return true
    // Read back rather than counted here — see the declaration.
    dropped = live.commands.dropped()
    return false
  }

  function receive(message: WorkletMessage): void {
    if (message.type === 'first-quantum') quantum = message.frames
    else if (message.type === 'kit-loaded') {
      kit = 'loaded'
      kitFailure = null
    } else if (message.type === 'kit-refused') {
      // The engine holds no kit after a refusal — it throws away the whole one
      // rather than half of it, which is why this can be a single word here.
      kit = 'failed'
      kitFailure = message.message
    }
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
    get dropped(): number {
      return dropped
    },
    get peakL(): number {
      return peakL
    },
    get peakR(): number {
      return peakR
    },
    get step(): number {
      return step
    },
    get playing(): boolean {
      return playing
    },
    get bpm(): number {
      return bpm
    },
    get metronome(): boolean {
      return metronome
    },
    get kit(): KitStatus {
      return kit
    },
    get kitFailure(): string | null {
      return kitFailure
    },
    start,
    stop(): void {
      discard(null)
    },
    toggle(): void {
      if (send({ op: playing ? 'stop' : 'play' })) playing = !playing
    },
    setBpm(next: number): void {
      if (send({ op: 'set-bpm', bpm: next })) bpm = next
    },
    setMetronome(enabled: boolean): void {
      if (send({ op: 'set-metronome', enabled })) metronome = enabled
    },
    trigger(track: number): void {
      // Full velocity: a pad is the sound as loud as the kit makes it, and what
      // scales it after that is the track's own fader.
      send({ op: 'trigger-track', track, velocity: 1 })
    },
  }
}
