// Main-thread setup for the audio engine: compile the module, load the
// worklet, hand the two together and connect the result to the speakers.
//
// Nothing here throws. Every way this can fail is a case in `StartFailure`,
// which is the point of the file: from the outside these failures are one
// event — the page is silent — while the fix for each is different.

import { createRing, openRing } from './ring'
import { createWriter } from './ring-writer'
import type { RingWriter } from './ring-writer'
import { err, messageOf, ok } from './result'
import type { Result } from './result'
import { createReader } from './telemetry'
import type { TelemetryReader } from './telemetry'
import type { KitSample, ReadyMessage, WorkletMessage } from './worklet-messages'

const WASM_URL = '/engine.wasm'
const WORKLET_URL = '/worklet/processor.js'

/**
 * How long the processor gets to say anything at all. It posts `ready` from
 * its own constructor, so the bound is only for the case where it never
 * answers — without one that is a promise pending forever and a button stuck
 * on "Starting…".
 */
const READY_TIMEOUT_MS = 5000

/**
 * What the page wants to hear about, beyond how starting went.
 *
 * Both are optional and both are about the same thing: the audio thread is
 * silent by default, and every one of its own failures presents on the page as
 * nothing happening.
 */
export interface EngineEvents {
  /** Every diagnostic the processor posts, `ready` and after. */
  onMessage?: (message: WorkletMessage) => void
  /**
   * The processor died after a successful start. `panic = "abort"` in the
   * release profile makes that the only shape a Rust panic can take: the
   * worklet is gone, sound will not come back without a reload, and nothing
   * else on the page changes — the last telemetry frame stays on screen and
   * the transport button goes on accepting clicks into a ring nobody drains.
   */
  onCrash?: () => void
}

export interface EngineHandle {
  readonly context: AudioContext
  readonly node: AudioWorkletNode
  /** The rate the context actually settled on, which is not always 48 kHz. */
  readonly sampleRate: number
  /** Reported by the compiled engine, not read from any TypeScript constant. */
  readonly protocolVersion: number
  /** The one way to reach the audio thread. Every gesture goes through here. */
  readonly commands: RingWriter
  /**
   * The one way to hear back from it. Read on two clocks — the snapshot on
   * every frame, the frame counter once a second, for the reason `renderDrift`
   * gives.
   */
  readonly telemetry: TelemetryReader
  /**
   * Put a kit into the engine. Everything loaded before it is replaced, and
   * every voice sounding from it stops.
   *
   * Not a command and not a second road into the engine: sixteen bytes is the
   * size of a record and megabytes is the size of a kit, so this is the port
   * rather than the ring — argued where the pair of calls it ends in is, at
   * `Engine::reserve_bank`.
   *
   * **The arrays are transferred, not copied**, so they are gone from this side
   * the moment this returns. That is what makes a kit cost one copy instead of
   * two, and it is why the caller must hand over arrays it has no further use
   * for — anything the page wants to keep, such as a waveform to draw, has to
   * be taken before the load rather than read back after it.
   *
   * The answer comes back through `EngineEvents.onMessage`, as `kit-loaded` or
   * `kit-refused`. Nothing is returned here: the audio thread is not asked
   * anything synchronously, ever.
   */
  loadKit(samples: readonly KitSample[]): void
}

export type StartFailure =
  | { readonly kind: 'ring-unavailable'; readonly message: string }
  | { readonly kind: 'context-unavailable'; readonly message: string }
  | { readonly kind: 'wasm-unavailable'; readonly message: string }
  | { readonly kind: 'worklet-unavailable'; readonly message: string }
  | { readonly kind: 'node-unavailable'; readonly message: string }
  | { readonly kind: 'processor-failed'; readonly message: string }
  | { readonly kind: 'processor-crashed' }
  | { readonly kind: 'processor-silent'; readonly ms: number }
  | { readonly kind: 'context-suspended'; readonly state: AudioContextState }

/**
 * One rule holds these together: **text that came from the browser goes last.**
 *
 * Not tidiness. A `DOMException` message ends with a full stop of its own, so a
 * sentence of ours continuing after it read `…load a worklet's module.. Build it
 * with pnpm build:worklet` on screen — in the one file whose whole purpose is a
 * legible failure. Whether foreign text is punctuated is not ours to know, so
 * nothing of ours follows it.
 */
export function describeStartFailure(failure: StartFailure): string {
  switch (failure.kind) {
    case 'ring-unavailable':
      return `SharedArrayBuffer is unavailable, so nothing can reach the audio thread. The page needs cross-origin isolation — check the COOP/COEP headers. The browser said: ${failure.message}`
    case 'context-unavailable':
      return `The browser would not open an AudioContext: ${failure.message}`
    case 'wasm-unavailable':
      return `${WASM_URL} could not be fetched or compiled. Build it with ./scripts/build-wasm.sh — the browser said: ${failure.message}`
    case 'worklet-unavailable':
      return `${WORKLET_URL} could not be loaded. Build it with pnpm build:worklet — the browser said: ${failure.message}`
    case 'node-unavailable':
      return `The worklet loaded but no processor named "engine" was registered in it: ${failure.message}`
    case 'processor-failed':
      return failure.message
    case 'processor-crashed':
      return 'The worklet processor threw before it could report a reason'
    case 'processor-silent':
      return `The worklet processor said nothing within ${failure.ms} ms — it was constructed but never reported ready or failed`
    case 'context-suspended':
      return `The audio context is ${failure.state}, not running. Autoplay policy blocks a context built outside a user gesture, and it does so silently`
  }
}

/**
 * Start the engine and connect it to the destination.
 *
 * Must be called from a user gesture. Built outside one, the context stays
 * `suspended` under the autoplay policy — nothing throws and nothing logs,
 * which is why the state is checked at the end rather than assumed.
 */
export async function startEngine(
  events: EngineEvents = {},
): Promise<Result<EngineHandle, StartFailure>> {
  // First, and before any device is opened: without shared memory there is no
  // path from the page to the audio thread at all, and an AudioContext that
  // can only render silence is worse than none.
  let ring: SharedArrayBuffer
  try {
    ring = createRing()
  } catch (error) {
    // A ReferenceError when the constructor is absent entirely, which is how a
    // page without cross-origin isolation presents.
    return err({ kind: 'ring-unavailable', message: messageOf(error) })
  }

  let context: AudioContext
  try {
    context = new AudioContext()
  } catch (error) {
    return err({ kind: 'context-unavailable', message: messageOf(error) })
  }

  const started = await bringUp(context, ring, events)

  // Released only on failure, which is the one shape a plain `acquireRelease`
  // does not give you: on success the context is the thing being returned and
  // must outlive this call. Left behind on a failed start it would hold an
  // audio device open for the lifetime of the page.
  if (!started.ok) await context.close().catch(() => undefined)

  return started
}

async function bringUp(
  context: AudioContext,
  ring: SharedArrayBuffer,
  events: EngineEvents,
): Promise<Result<EngineHandle, StartFailure>> {
  // Compiling here rather than inside the worklet is not a preference:
  // AudioWorkletGlobalScope has neither fetch nor XMLHttpRequest. A compiled
  // module does survive structured clone, so it goes over in processorOptions.
  //
  // The loads overlap, but each maps its own rejection before they join: the
  // two artifacts are rebuilt by different scripts, so "one of them is
  // missing" would not be an answer anyone could act on.
  const [module, worklet] = await Promise.all([
    WebAssembly.compileStreaming(fetch(WASM_URL)).then(ok, (error: unknown) =>
      err({ kind: 'wasm-unavailable' as const, message: messageOf(error) }),
    ),
    context.audioWorklet.addModule(WORKLET_URL).then(
      () => ok(undefined),
      (error: unknown) =>
        err({ kind: 'worklet-unavailable' as const, message: messageOf(error) }),
    ),
  ])
  if (!module.ok) return module
  if (!worklet.ok) return worklet

  let node: AudioWorkletNode
  try {
    node = new AudioWorkletNode(context, 'engine', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      // Both cross by structured clone: a compiled module survives it, and a
      // SharedArrayBuffer crosses as the same memory rather than a copy, which
      // is the entire point of it being one.
      processorOptions: { module: module.value, ring },
    })
  } catch (error) {
    // The module loaded but `registerProcessor('engine', …)` never ran in it,
    // or ran under another name.
    return err({ kind: 'node-unavailable', message: messageOf(error) })
  }

  const ready = await awaitReady(node, events, READY_TIMEOUT_MS)
  if (!ready.ok) return ready

  node.connect(context.destination)
  await context.resume()

  // `resume()` does not reject when the autoplay policy refuses; the context
  // simply stays suspended. This is the check that turns the failure this
  // file's own header warns about into something reportable.
  if (context.state !== 'running') {
    return err({ kind: 'context-suspended', state: context.state })
  }

  // Opened once, here, and shared by both directions — the page's counterpart
  // of the single `openRing` the worklet does at bring-up. Only now, too: the
  // processor reported `ready`, so the far end of this ring is draining it,
  // and a writer handed out before that would accept commands into a buffer
  // nobody reads.
  const views = openRing(ring)

  return ok({
    context,
    node,
    sampleRate: ready.value.sampleRate,
    protocolVersion: ready.value.protocolVersion,
    commands: createWriter(views),
    telemetry: createReader(views),
    loadKit: (samples) => {
      node.port.postMessage(
        { type: 'load-kit', samples },
        samples.map((sample) => sample.data.buffer),
      )
    },
  })
}

/**
 * The part of `AudioWorkletNode` that bring-up listens to. Narrow on purpose:
 * a real node cannot be constructed outside a browser, and against this shape
 * every failure below is reachable from a test.
 */
export interface ReadyEndpoint {
  port: { onmessage: ((event: MessageEvent<WorkletMessage>) => void) | null }
  // `ErrorEvent` and not `Event`: that is how lib.dom types the property, and
  // a wider parameter here would stop a real node from fitting the shape.
  onprocessorerror: ((event: ErrorEvent) => void) | null
}

/**
 * Wait for the processor to report how it went. Both listeners stay installed
 * afterward on purpose, and for different reasons: `first-quantum` arrives
 * later and `onMessage` is the only thing that will see it, while a processor
 * error after the verdict is no longer a failed start but a dead engine.
 */
export function awaitReady(
  node: ReadyEndpoint,
  events: EngineEvents,
  timeoutMs: number,
): Promise<Result<ReadyMessage, StartFailure>> {
  return new Promise((resolve) => {
    const timer = setTimeout(
      () => resolve(err({ kind: 'processor-silent', ms: timeoutMs })),
      timeoutMs,
    )

    // Tracked rather than inferred from a second `resolve` being a no-op: the
    // verdict having been reached is what tells the two meanings of
    // `onprocessorerror` apart, and nothing else can. Clearing the timer is
    // this function's own business either way — left running it holds the page
    // awake for whatever it has left.
    let settled = false
    const settle = (result: Result<ReadyMessage, StartFailure>): void => {
      clearTimeout(timer)
      settled = true
      resolve(result)
    }

    node.port.onmessage = (event: MessageEvent<WorkletMessage>) => {
      const message = event.data
      events.onMessage?.(message)
      if (message.type === 'ready') settle(ok(message))
      else if (message.type === 'failed') {
        settle(err({ kind: 'processor-failed', message: message.message }))
      }
    }

    // Before the verdict: whatever escaped before the processor could describe
    // its own failure, and all this end ever learns about it.
    //
    // After it: the engine ran and is now gone, which is the crash `onCrash`
    // is declared for. Reported as a value would be wrong, the start having
    // already succeeded; unreported it is a page that goes on showing a
    // transport nobody is rendering.
    node.onprocessorerror = () => {
      if (settled) events.onCrash?.()
      else settle(err({ kind: 'processor-crashed' }))
    }
  })
}
