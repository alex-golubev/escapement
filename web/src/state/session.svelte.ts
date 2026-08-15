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
import { STEPS, TRACKS } from '../audio/protocol'
import type { Command } from '../audio/protocol'
import type { Result } from '../audio/result'
import type { Telemetry } from '../audio/telemetry'
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
 * The master level a page opens at, told to the engine for the reason above.
 *
 * Unity, and not something lower to keep a full grid off the limiter. Eight
 * tracks at their own unity sum to 5.66 by decision — that is what the limiter
 * is there for and what the fader is there to answer — so a page that opened
 * quieter would be settling a question about the mix with a number nobody
 * chose, and settling it where it could never be seen.
 */
const INITIAL_MASTER_GAIN = 1

/**
 * How hard a struck cell hits.
 *
 * Its own constant rather than a reference to the pad's, which holds the same
 * number today: a pad is as loud as the kit makes it, a cell is as loud as the
 * page has any way to say, and neither follows from the other. Tied by a
 * reference they would move together the first time one of them was meant to
 * move alone.
 *
 * One number at all, and not a range, because this milestone has no velocity
 * editor. The engine keeps a velocity per cell and the wire carries it; what
 * the page lacks is anywhere to set one, so a cell is on or off and `0` is what
 * off is. Remembering that a struck-out cell was at 0.7 is the document's job,
 * and the document arrives on M2.
 */
const CELL_VELOCITY = 1

/** A grid with nothing in it. The shape every pattern here has. */
function emptyPattern(): boolean[][] {
  return Array.from({ length: TRACKS }, () => new Array<boolean>(STEPS).fill(false))
}

/**
 * Whether a cell exists.
 *
 * Unreachable from a grid built on `TRACKS` and `STEPS`, which is where those
 * two are kept so that nobody draws a grid of their own size. So this is not
 * about the sound: the engine drops an index past the end of its own grid
 * already, and drops it correctly. It is about this side's array, where the two
 * ways out of range fail differently and neither is the engine's to catch — a
 * track past the end assigns through `undefined` and throws inside an event
 * handler, while a step past the end quietly lengthens one row, leaving the
 * grid ragged with no loop that walks it any the wiser.
 */
function inGrid(track: number, step: number): boolean {
  return (
    Number.isInteger(track) &&
    Number.isInteger(step) &&
    track >= 0 &&
    track < TRACKS &&
    step >= 0 &&
    step < STEPS
  )
}

/**
 * How long a readout on screen must hold still, in milliseconds.
 *
 * Not the frame rate, and the gap between the two was measured rather than
 * guessed. Milestone 0 found a page updating 68 times a second costing 21.8% of
 * a core, and the obvious culprit was not it: the main thread with style and
 * layout came to 1.26%, and hiding the meters moved no number at all. What the
 * cost is linear in is updates per second — near 0.2% of a core each — because
 * every one of them runs paint, rasterisation and compositing in threads no
 * in-page profiler can see. At fifteen a second that term is under 4%, and
 * nobody reads a clock faster than that anyway.
 *
 * The playhead is deliberately not on this clock. It is drawn from `onFrame`,
 * where a frame is worth having, onto a canvas that never touches a component.
 *
 * Exported for its spec, which asserts that its fixtures fall on both sides of
 * this number — a threshold test whose fixture never reaches the threshold
 * passes with the guard removed, and passes quietly.
 */
export const READOUT_INTERVAL_MS = 66

/**
 * Run `tick` on every frame, and hand back the way to stop it.
 *
 * A parameter rather than `requestAnimationFrame` reached for directly, for the
 * same reason `openEngine` takes `EngineExports` rather than a module: under
 * Node there are no frames and no `AudioContext`, so every path in this file
 * would be a path no test could take.
 *
 * The timestamp is the one `requestAnimationFrame` already hands its callback.
 * Taken from there rather than read off a clock inside the loop, because the
 * throttle above then has a time a test can state, instead of one it would have
 * to wait for.
 */
export type FrameLoop = (tick: (now: number) => void) => () => void

const browserFrames: FrameLoop = (tick) => {
  let frame = requestAnimationFrame(function next(now) {
    tick(now)
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
  readonly masterGain: number
  readonly kit: KitStatus
  /** Why the kit is not loaded, when that is known. */
  readonly kitFailure: string | null
  /**
   * Take every telemetry reading as it arrives, and hand back the way to stop.
   *
   * The one road out of here that is not a rune, and it exists because the
   * playhead has to move on every frame while nothing on the page may. A field
   * written sixty times a second would wake the reactive graph sixty times a
   * second, and past it a paint of everything downstream — which is the cost
   * `READOUT_INTERVAL_MS` was measured against. A listener drawing on a canvas
   * costs the reactive graph nothing at all.
   *
   * Never called with a reading that came back null: a frame the seqlock refused
   * is a frame with nothing new, and the canvas keeps what it already drew for
   * the same reason the numbers do.
   */
  onFrame(listener: (reading: Telemetry) => void): () => void
  start(): Promise<void>
  /** Give the device back. The counterpart of `start`, and what every failure path uses. */
  stop(): void
  toggle(): void
  setBpm(bpm: number): void
  setMetronome(enabled: boolean): void
  setMasterGain(gain: number): void
  /**
   * Whether a cell is struck.
   *
   * A question rather than the array itself, and for the reason at the top of
   * this file: an array handed out is an array a component can write to, and
   * writing to it would be a road into the page's belief that reaches no
   * engine — the one divergence nothing here could detect. Reactivity is
   * unaffected either way, because the read happens inside whatever scope
   * called this, so a template depends on the single cell it asked about and
   * not on the grid.
   */
  isStepOn(track: number, step: number): boolean
  /** Strike a cell or clear it. Off travels as velocity `0`; there is no flag. */
  setStep(track: number, step: number, on: boolean): void
  /**
   * Empty the whole grid.
   *
   * One record rather than 128 of them, which is the whole reason the opcode
   * exists: clearing by hand would be a burst larger than the exchange area the
   * engine drains in a quantum, to say something one byte already says.
   */
  clearPattern(): void
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
  let masterGain = $state(INITIAL_MASTER_GAIN)

  /**
   * The pattern the page holds, one boolean a cell.
   *
   * Deep `$state`, and deliberately not the `$state.raw` the handle above is:
   * there the proxy costs a hop on every send and buys nothing, here it is the
   * whole point. A click writes one cell, and only what reads that cell hears
   * about it. Made raw — or kept as a value replaced whole on each click — all
   * 128 cells would invalidate together on every edit, which is the cost the
   * framework was chosen to avoid rather than pay in a different place.
   *
   * `const`, because nothing ever replaces it: `discard` leaves it alone. It is
   * a setting the page holds and hands to whatever engine it has, exactly like
   * the tempo, and the argument for that is in `discard`.
   */
  const pattern = $state(emptyPattern())

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

  /**
   * Who is drawing from the readings, and when the last one reached the screen.
   *
   * Plain, not runes: a listener is called by the frame loop and a timestamp is
   * compared by it, and neither is ever read from a reactive scope — which is
   * the whole point of them. Not cleared when the engine is given back, either:
   * a subscription belongs to whatever mounted it, and the loop stopping is
   * already the only thing that could reach it.
   */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- reactive is what this deliberately is not; see above
  const listeners = new Set<(reading: Telemetry) => void>()
  let publishedAt = Number.NEGATIVE_INFINITY

  function readTelemetry(now: number): void {
    const live = handle
    if (live === null) return
    const reading = live.telemetry.read()
    // Null is the writer having been mid-publish every time this looked, which is
    // not an error: the previous frame's numbers stand and the next frame is 16 ms
    // away.
    if (reading === null) return

    // Every frame, and ahead of the throttle. This is the half that has to be
    // smooth, and it goes to a canvas rather than into the reactive graph — one
    // reading serving both, so the playhead and the numbers can never be looking
    // at different quanta.
    for (const listener of listeners) listener(reading)

    if (now - publishedAt < READOUT_INTERVAL_MS) return
    publishedAt = now
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
    // Through the ordinary write path and not something start does specially,
    // because this is in miniature the path a project being opened will take:
    // a settled belief on this side, poured into an engine that holds none.
    send({ op: 'set-bpm', bpm })
    send({ op: 'set-metronome', enabled: metronome })
    send({ op: 'set-master-gain', gain: masterGain })
    installPattern()

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
   * Put the page's pattern into an engine that is holding none.
   *
   * Sent on every start, not only when there is something in it to send. A path
   * taken once in a while is a path taken almost never — until a project can be
   * opened, the only way to reach this with a pattern in hand is the restart
   * button after a failure — and a path that rots is worse than one that costs a
   * record. `ClearPattern` ahead of the cells is what makes the call independent
   * of whatever the engine came up holding, so the same three lines serve a
   * fresh engine and a reused one.
   *
   * This is the page's first bulk send, and the rule the single-command callers
   * follow does not carry over: they gate a belief on the command being
   * accepted, while these carry a belief that is already settled and merely
   * unheard. So there is nothing here to leave unchanged on a refusal, and
   * nothing is resent. At 129 records against a ring of 1024 the only way to be
   * refused is the far end having stopped draining, which ends the session with
   * a message of its own; short of that, the drop counter is on screen and says
   * it. What this shape is really for is M2, where the same call arrives with
   * hundreds of records and the answer stops being obvious.
   */
  function installPattern(): void {
    send({ op: 'clear-pattern' })
    for (let track = 0; track < TRACKS; track += 1) {
      for (let step = 0; step < STEPS; step += 1) {
        if (pattern[track][step]) send({ op: 'set-step', track, step, velocity: CELL_VELOCITY })
      }
    }
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
    get masterGain(): number {
      return masterGain
    },
    get kit(): KitStatus {
      return kit
    },
    get kitFailure(): string | null {
      return kitFailure
    },
    onFrame(listener: (reading: Telemetry) => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
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
    setMasterGain(gain: number): void {
      if (send({ op: 'set-master-gain', gain })) masterGain = gain
    },
    isStepOn(track: number, step: number): boolean {
      return inGrid(track, step) && pattern[track][step]
    },
    setStep(track: number, step: number, on: boolean): void {
      // Nothing sent and nothing believed: see `inGrid`. Silent because the only
      // way to arrive here is a caller that made up its own grid size, and a
      // channel back for that would be a channel for a bug this file cannot have.
      if (!inGrid(track, step)) return
      if (send({ op: 'set-step', track, step, velocity: on ? CELL_VELOCITY : 0 })) {
        pattern[track][step] = on
      }
    },
    clearPattern(): void {
      if (!send({ op: 'clear-pattern' })) return
      for (const row of pattern) row.fill(false)
    },
    trigger(track: number): void {
      // Full velocity: a pad is the sound as loud as the kit makes it, and what
      // scales it after that is the track's own fader.
      send({ op: 'trigger-track', track, velocity: 1 })
    },
  }
}
