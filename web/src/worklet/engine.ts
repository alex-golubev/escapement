// Bringing the engine up, apart from processor.ts because that file calls
// `registerProcessor` on load: nothing can import out of it, and every line in
// it is reachable only from a browser. The steps here are the failure paths,
// and a failure path that has never run is a guess.
//
// Errors are returned, not thrown, and that is forced rather than preferred:
// nothing thrown from the processor constructor can explain itself to the page
// — the reason is written beside `FailedMessage` — so every throw would have
// to be caught and converted anyway.

import { COMMAND_SIZE, PROTOCOL_VERSION } from '../audio/protocol'
import { RING_BYTES, WORD_PROTOCOL_VERSION, headerWords, openRing } from '../audio/ring'
import type { RingViews } from '../audio/ring'
import { TELEMETRY_WORDS } from './telemetry-block'

/**
 * A failure that is a value. Declared again in audio/host.ts on purpose: the
 * two never exchange these values — different threads, neither calls the other
 * — so a shared type would link them by name without linking anything real.
 *
 * What that argument turns on is the boundary, not the file, and it is worth
 * saying now that there are three of these — the tests carry a structural one
 * of their own. A second module on *this* side of the boundary does not get a
 * fourth: it takes the one already here, and if that means moving the
 * declaration out to a file of its own on this side, that is a move rather
 * than a copy. `kit.ts` is the first such module and imports these — along with
 * `describeValue` and `messageOf` below, which are the same question about the
 * same boundary. No file of their own was needed; one becomes worth making when
 * bring-up is no longer the natural place to look for them.
 */
export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E }

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value })
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error })

/** The C ABI of the compiled engine. Pointers are offsets into linear memory. */
export interface EngineExports {
  memory: WebAssembly.Memory
  engine_protocol_version(): number
  engine_new(sampleRate: number, maxFrames: number): number
  /**
   * Declared, and deliberately never called from here.
   *
   * The processor's lifetime is the context's lifetime: there is no message that
   * ends it, and linear memory dies with the worklet global scope when the page
   * closes the context. A free issued from this side would have to prove that no
   * `process` call is in flight, which the worklet cannot know — so the pairing
   * is kept by not allocating twice rather than by freeing. That turns on when a
   * free could be issued and not on what would be freed, so an instance that
   * comes to hold more — sample data, when there is some — does not reopen it.
   *
   * It is not dead ABI. The caller that needs it is the offline renderer on M3,
   * which builds and drops instances off the audio thread entirely, and
   * `engine-abi.spec.ts`, which does exactly that today.
   */
  engine_free(instance: number): void
  engine_out_ptr(instance: number, channel: number): number
  engine_cmd_ptr(instance: number): number
  engine_cmd_capacity(instance: number): number
  engine_telemetry_ptr(instance: number): number
  engine_process(instance: number, frames: number, cmdCount: number): void
  /**
   * Make room for a whole kit, and hand back where to write it. Zero is a
   * refusal, exactly as it is from `engine_new`.
   *
   * **The address it returns is valid until the next reservation**, which
   * replaces the arena rather than adding to it — so a view built over it
   * belongs to the load that asked for it and is dropped when that load ends.
   * It must never join `EngineViews`: those are rebuilt from stored pointers
   * whenever the buffer changes, and rebuilding this one would aim a fresh view
   * at an address the engine has already given up.
   *
   * Growing the arena is what makes `buildViews` above load-bearing rather than
   * precautionary — see there.
   */
  engine_bank_reserve(instance: number, floats: number): number
  /**
   * Declare what was written into the arena. Zero is acceptance; anything else
   * is a refusal, and **this side does not name which.** The reason is argued
   * beside the codes in `lib.rs`: a table of names here would be a second
   * description of that list, disagreeing silently. What the caller reports
   * instead is the number together with the arguments it just passed, which it
   * has and the engine does not.
   */
  engine_sample_commit(
    instance: number,
    slot: number,
    offset: number,
    frames: number,
    channels: number,
  ): number
}

/** Every view over linear memory the worklet holds. Replaced as a set. */
export interface EngineViews {
  /** The buffer these views were built over, kept to detect a detach. */
  readonly buffer: ArrayBufferLike
  readonly outL: Float32Array
  readonly outR: Float32Array
  readonly telemetry: Uint32Array
  /** The exchange area: where command bytes are copied to, out of the ring. */
  readonly cmd: Uint8Array
}

export interface EngineState {
  readonly exports: EngineExports
  readonly instance: number
  readonly maxFrames: number
  /** As the compiled engine reported it, kept so nothing asks a second time. */
  readonly protocolVersion: number
  /** Records the exchange area holds, as `engine_cmd_capacity` reported it. */
  readonly cmdCapacity: number
  /** Views over the SharedArrayBuffer. Unlike the ones above, these never detach. */
  readonly ring: RingViews
  readonly views: EngineViews
}

/**
 * Everything that can go wrong before the first quantum. Tagged so a test can
 * assert on the case rather than on prose, and so a new case fails to compile
 * in `describeInitError` instead of falling through to nothing.
 */
export type EngineInitError =
  | { readonly kind: 'no-module'; readonly received: string }
  | { readonly kind: 'no-ring'; readonly received: string }
  | { readonly kind: 'ring-too-small'; readonly bytes: number; readonly needed: number }
  | { readonly kind: 'ring-version-mismatch'; readonly ring: number; readonly worklet: number }
  | { readonly kind: 'instantiation-failed'; readonly message: string }
  | { readonly kind: 'abi-unusable'; readonly message: string }
  | { readonly kind: 'protocol-mismatch'; readonly engine: number; readonly expected: number }
  | { readonly kind: 'engine-refused'; readonly sampleRate: number; readonly maxFrames: number }

/**
 * Both ring failures have one fix, and it is not a fix anyone guesses.
 *
 * `public/worklet/processor.js` is built by a script of its own and sits
 * outside Vite's module graph, so it is the half that stays behind: an edit
 * reloads the page and leaves the bundle where it was. Everything else can be
 * right and the worklet still be last week's program in front of today's page.
 */
const REBUILD_WORKLET =
  'The page and the worklet are separate build artifacts; rebuild with pnpm build:worklet.'

export function describeInitError(error: EngineInitError): string {
  switch (error.kind) {
    case 'no-module':
      return `processorOptions.module is missing or not a WebAssembly.Module (got ${error.received})`
    case 'no-ring':
      return `processorOptions.ring is missing or not a SharedArrayBuffer (got ${error.received})`
    case 'ring-too-small':
      return (
        `The command ring is ${error.bytes} bytes, and this build reads ${error.needed}. ` +
        REBUILD_WORKLET
      )
    case 'ring-version-mismatch':
      return (
        `Protocol mismatch across the ring: the page stamped ${error.ring}, this worklet ` +
        `encodes ${error.worklet}. ${REBUILD_WORKLET}`
      )
    case 'instantiation-failed':
      return `The engine module did not instantiate: ${error.message}`
    case 'abi-unusable':
      return `The engine module instantiated but its ABI could not be called: ${error.message}`
    case 'protocol-mismatch':
      return (
        `Protocol mismatch: the engine reports ${error.engine}, this build expects ` +
        `${error.expected}. Rebuild the wasm module, or reconcile both halves of ` +
        `the ABI — commands.rs with protocol.ts, and the telemetry block in ` +
        `engine.rs with telemetry-block.ts.`
      )
    case 'engine-refused':
      return `engine_new refused sampleRate=${error.sampleRate}, maxFrames=${error.maxFrames}`
  }
}

/**
 * Pull the compiled module out of the option bag the node was constructed
 * with. `processorOptions` is `any` in lib.dom and arrives from another thread
 * through structured clone, so it is narrowed by a check, not described by a
 * cast.
 */
export function readModule(
  processorOptions: unknown,
): Result<WebAssembly.Module, EngineInitError> {
  const provided = processorOptions as { module?: unknown } | undefined
  const module = provided?.module
  if (!(module instanceof WebAssembly.Module)) {
    return err({ kind: 'no-module', received: describeValue(module) })
  }
  return ok(module)
}

/**
 * Take the ring out of the same option bag, and check that it was built by a
 * page that agrees with this bundle.
 *
 * The version word cannot prove anything about Rust — the page stamped it from
 * the same `protocol.ts` this file reads. What it does prove is that the two
 * JavaScript artifacts came from one edit, which is the everyday mistake
 * `REBUILD_WORKLET` above is written for, and whose symptom is silence.
 */
export function readRing(
  processorOptions: unknown,
): Result<SharedArrayBuffer, EngineInitError> {
  const provided = processorOptions as { ring?: unknown } | undefined
  const ring = provided?.ring
  if (!(ring instanceof SharedArrayBuffer)) {
    return err({ kind: 'no-ring', received: describeValue(ring) })
  }
  if (ring.byteLength < RING_BYTES) {
    return err({ kind: 'ring-too-small', bytes: ring.byteLength, needed: RING_BYTES })
  }

  // Through the same header view the page stamped it with. Read off a
  // one-element view of its own, this held only while the word stayed at index
  // zero: move it, and the read is `undefined` and every start fails with a
  // mismatch against a number that was never there.
  const stamped = Atomics.load(headerWords(ring), WORD_PROTOCOL_VERSION)
  if (stamped !== PROTOCOL_VERSION) {
    return err({ kind: 'ring-version-mismatch', ring: stamped, worklet: PROTOCOL_VERSION })
  }
  return ok(ring)
}

/**
 * Check the engine over and take a handle from it.
 *
 * Takes exports rather than a module on purpose: a test can hand this an
 * engine that reports the wrong version or refuses the arguments, neither of
 * which the real artifact will ever do on demand.
 */
export function openEngine(
  exports: EngineExports,
  ring: RingViews,
  sampleRate: number,
  maxFrames: number,
): Result<EngineState, EngineInitError> {
  let engineVersion: number
  let instance: number
  let cmdCapacity: number
  let views: EngineViews
  try {
    engineVersion = exports.engine_protocol_version()
    if (engineVersion !== PROTOCOL_VERSION) {
      return err({
        kind: 'protocol-mismatch',
        engine: engineVersion,
        expected: PROTOCOL_VERSION,
      })
    }
    instance = exports.engine_new(sampleRate, maxFrames)

    // Zero means the engine refused the arguments. Rendering through it would
    // be a wild pointer on the audio thread, so it is checked here and nowhere
    // later — and before the handle is asked for anything else.
    if (instance === 0) {
      return err({ kind: 'engine-refused', sampleRate, maxFrames })
    }

    // Read once, here. It sizes the view over the exchange area, and the size
    // of that view is in turn what caps a quantum's worth of commands — so the
    // number the drain obeys and the number the engine allocated for cannot
    // become two different numbers.
    cmdCapacity = exports.engine_cmd_capacity(instance)

    // Inside the same block as the calls above, and that is the whole point:
    // this is where the other five ABI functions are first called, and where
    // the pointers they return are first believed. Left outside, a module
    // missing `engine_out_ptr` — or handing back an address that does not fit
    // the memory behind it — threw straight out of the processor constructor,
    // which is the one place a reason cannot survive and the exact failure this
    // union exists to prevent.
    views = buildViews(exports, instance, maxFrames, cmdCapacity)
  } catch (error) {
    // A missing or non-function export lands here, and so does a RangeError
    // from a view that does not fit. `build-wasm.sh` guards the export
    // surface, but skips that check when node is absent — and it cannot check
    // the pointers at all.
    return err({ kind: 'abi-unusable', message: messageOf(error) })
  }

  return ok({
    exports,
    instance,
    maxFrames,
    protocolVersion: engineVersion,
    cmdCapacity,
    ring,
    views,
  })
}

/**
 * Build every view over linear memory. The only place they are constructed.
 *
 * `memory.grow` detaches every existing view, and it can happen between two
 * `process()` calls — inside `port.onmessage`, where the processor has no way
 * to observe it. Pre-allocating the hot buffers removes the main reason to
 * grow; `refreshViews` covers the rest.
 */
export function buildViews(
  exports: EngineExports,
  instance: number,
  maxFrames: number,
  cmdCapacity: number,
): EngineViews {
  const buffer = exports.memory.buffer
  return {
    buffer,
    outL: new Float32Array(buffer, exports.engine_out_ptr(instance, 0), maxFrames),
    outR: new Float32Array(buffer, exports.engine_out_ptr(instance, 1), maxFrames),
    telemetry: new Uint32Array(buffer, exports.engine_telemetry_ptr(instance), TELEMETRY_WORDS),
    // Bytes, not words: the exchange area is a `Vec<u8>` on the Rust side and
    // carries no alignment guarantee, so a Uint32Array over it is not always
    // constructible.
    cmd: new Uint8Array(buffer, exports.engine_cmd_ptr(instance), cmdCapacity * COMMAND_SIZE),
  }
}

/**
 * The whole bring-up, in the order the processor needs it. The one step no
 * fake can stand in for is the instantiation; `tests/engine-abi.spec.ts`
 * covers that against the real artifact.
 */
export function initEngine(
  processorOptions: unknown,
  sampleRate: number,
  maxFrames: number,
): Result<EngineState, EngineInitError> {
  const module = readModule(processorOptions)
  if (!module.ok) return module

  const ring = readRing(processorOptions)
  if (!ring.ok) return ring

  // Synchronous, and it has to be: the constructor cannot await. The module
  // was compiled on the main thread, where fetch exists, and handed over
  // through structured clone.
  let exports: EngineExports
  try {
    exports = new WebAssembly.Instance(module.value, {}).exports as unknown as EngineExports
  } catch (error) {
    return err({ kind: 'instantiation-failed', message: messageOf(error) })
  }

  return openEngine(exports, openRing(ring.value), sampleRate, maxFrames)
}

/** The twin of the one in audio/host.ts, which is where the reason is written. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** What arrived, when what arrived is not what was wanted. */
export function describeValue(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  return typeof value
}
