// Bringing the engine up, apart from processor.ts because that file calls
// `registerProcessor` on load: nothing can import out of it, and every line in
// it is reachable only from a browser. The steps here are the failure paths,
// and a failure path that has never run is a guess.
//
// Errors are returned, not thrown, and that is forced rather than preferred:
// the constructor cannot let an exception escape — it would reach the page as
// a bare `processorerror` carrying no reason — so every throw would have to be
// caught and converted anyway.

import { PROTOCOL_VERSION, TELEMETRY_WORDS } from '../audio/protocol'

/**
 * A failure that is a value. Declared again in audio/host.ts on purpose: the
 * two never exchange these values — different threads, neither calls the other
 * — so a shared type would link them by name without linking anything real.
 */
type Result<T, E> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E }

const ok = <T>(value: T): Result<T, never> => ({ ok: true, value })
const err = <E>(error: E): Result<never, E> => ({ ok: false, error })

/** The C ABI of the compiled engine. Pointers are offsets into linear memory. */
export interface EngineExports {
  memory: WebAssembly.Memory
  engine_protocol_version(): number
  engine_new(sampleRate: number, maxFrames: number): number
  engine_free(instance: number): void
  engine_out_ptr(instance: number, channel: number): number
  engine_cmd_ptr(instance: number): number
  engine_cmd_capacity(instance: number): number
  engine_telemetry_ptr(instance: number): number
  engine_process(instance: number, frames: number, cmdCount: number): void
}

/** Every view over linear memory the worklet holds. Replaced as a set. */
export interface EngineViews {
  /** The buffer these views were built over, kept to detect a detach. */
  readonly buffer: ArrayBufferLike
  readonly outL: Float32Array
  readonly outR: Float32Array
  readonly telemetry: Uint32Array
}

export interface EngineState {
  readonly exports: EngineExports
  readonly instance: number
  readonly maxFrames: number
  /** As the compiled engine reported it, kept so nothing asks a second time. */
  readonly protocolVersion: number
  readonly views: EngineViews
}

/**
 * Everything that can go wrong before the first quantum. Tagged so a test can
 * assert on the case rather than on prose, and so a new case fails to compile
 * in `describeInitError` instead of falling through to nothing.
 */
export type EngineInitError =
  | { readonly kind: 'no-module'; readonly received: string }
  | { readonly kind: 'instantiation-failed'; readonly message: string }
  | { readonly kind: 'abi-unusable'; readonly message: string }
  | { readonly kind: 'protocol-mismatch'; readonly engine: number; readonly expected: number }
  | { readonly kind: 'engine-refused'; readonly sampleRate: number; readonly maxFrames: number }

export function describeInitError(error: EngineInitError): string {
  switch (error.kind) {
    case 'no-module':
      return `processorOptions.module is missing or not a WebAssembly.Module (got ${error.received})`
    case 'instantiation-failed':
      return `The engine module did not instantiate: ${error.message}`
    case 'abi-unusable':
      return `The engine module instantiated but its ABI could not be called: ${error.message}`
    case 'protocol-mismatch':
      return (
        `Protocol mismatch: the engine reports ${error.engine}, this build expects ` +
        `${error.expected}. Rebuild the wasm module, or reconcile commands.rs ` +
        `with its TypeScript mirror.`
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
 * Check the engine over and take a handle from it.
 *
 * Takes exports rather than a module on purpose: a test can hand this an
 * engine that reports the wrong version or refuses the arguments, neither of
 * which the real artifact will ever do on demand.
 */
export function openEngine(
  exports: EngineExports,
  sampleRate: number,
  maxFrames: number,
): Result<EngineState, EngineInitError> {
  let engineVersion: number
  let instance: number
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
  } catch (error) {
    // A missing or non-function export lands here. `build-wasm.sh` guards the
    // surface, but skips that check when node is absent.
    return err({ kind: 'abi-unusable', message: messageOf(error) })
  }

  // Zero means the engine refused the arguments. Rendering through it would be
  // a wild pointer on the audio thread, so it is checked here and nowhere
  // later.
  if (instance === 0) {
    return err({ kind: 'engine-refused', sampleRate, maxFrames })
  }

  return ok({
    exports,
    instance,
    maxFrames,
    protocolVersion: engineVersion,
    views: buildViews(exports, instance, maxFrames),
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
): EngineViews {
  const buffer = exports.memory.buffer
  return {
    buffer,
    outL: new Float32Array(buffer, exports.engine_out_ptr(instance, 0), maxFrames),
    outR: new Float32Array(buffer, exports.engine_out_ptr(instance, 1), maxFrames),
    telemetry: new Uint32Array(buffer, exports.engine_telemetry_ptr(instance), TELEMETRY_WORDS),
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

  // Synchronous, and it has to be: the constructor cannot await. The module
  // was compiled on the main thread, where fetch exists, and handed over
  // through structured clone.
  let exports: EngineExports
  try {
    exports = new WebAssembly.Instance(module.value, {}).exports as unknown as EngineExports
  } catch (error) {
    return err({ kind: 'instantiation-failed', message: messageOf(error) })
  }

  return openEngine(exports, sampleRate, maxFrames)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function describeValue(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  return typeof value
}
