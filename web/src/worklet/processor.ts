// The worklet half of the engine. Everything below `process()` runs on the
// audio thread, where the rules are absolute: no allocation, no locks, no
// logging, no exceptions. A violation is not a slow frame, it is a dropout.
//
// This file is bundled standalone by scripts/build-worklet.sh. It must not
// depend on anything that survives bundling as an import — AudioWorkletGlobal-
// Scope has no module loader.

import type { WorkletMessage } from '../audio/worklet-messages'

/**
 * Web Audio renders in blocks of exactly this size and offers no way to change
 * it. The engine is allocated for it, and the first observed quantum is
 * reported back so the assumption stops being an assumption.
 */
const QUANTUM = 128

/**
 * Mirror of `PROTOCOL_VERSION` in crates/engine/src/commands.rs.
 *
 * It is compared against the number the *compiled engine* reports, never
 * against a copy of itself. A version written by this side and checked by this
 * side proves only that TypeScript agrees with TypeScript; the drift worth
 * catching is between the wasm module and this file.
 */
const PROTOCOL_VERSION = 1

/** Telemetry word count, mirroring `TELEMETRY_WORDS` in engine.rs. */
const TELEMETRY_WORDS = 4

/** The C ABI of the compiled engine. Pointers are offsets into linear memory. */
interface EngineExports {
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

// AudioWorklet globals are absent from lib.dom, and @types/audioworklet
// redefines enough of it to collide when both are in one program. The surface
// used here is small enough to declare in place.
declare const sampleRate: number
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort
}
declare function registerProcessor(
  name: string,
  processorCtor: new (options: AudioWorkletNodeOptions) => AudioWorkletProcessor,
): void

class EngineProcessor extends AudioWorkletProcessor {
  #exports: EngineExports | null = null
  #instance = 0

  // Views over WASM linear memory, rebuilt whenever the buffer is replaced.
  #buffer: ArrayBufferLike | null = null
  #outL = new Float32Array(0)
  #outR = new Float32Array(0)
  #telemetry = new Uint32Array(0)

  #firstQuantumReported = false

  constructor(options: AudioWorkletNodeOptions) {
    super()
    try {
      this.#init(options)
      this.#post({
        type: 'ready',
        sampleRate,
        protocolVersion: this.#exports!.engine_protocol_version(),
      })
    } catch (error) {
      // Left un-rethrown deliberately. A throw here reaches the page as a bare
      // `processorerror` event with no reason attached; the message below is
      // the only way the cause crosses the thread boundary.
      this.#exports = null
      this.#post({
        type: 'failed',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  #init(options: AudioWorkletNodeOptions): void {
    const module = options.processorOptions?.module as WebAssembly.Module | undefined
    if (!(module instanceof WebAssembly.Module)) {
      throw new Error('processorOptions.module is missing or not a WebAssembly.Module')
    }

    // Synchronous, and it has to be: the constructor cannot await. The module
    // was compiled on the main thread, where fetch exists, and handed over
    // through structured clone.
    const instance = new WebAssembly.Instance(module, {})
    const exports = instance.exports as unknown as EngineExports

    const engineVersion = exports.engine_protocol_version()
    if (engineVersion !== PROTOCOL_VERSION) {
      throw new Error(
        `Protocol mismatch: the engine reports ${engineVersion}, this build expects ` +
          `${PROTOCOL_VERSION}. Rebuild the wasm module, or reconcile commands.rs ` +
          `with its TypeScript mirror.`,
      )
    }

    // Null means the engine refused the arguments. Rendering through a null
    // instance would be a wild pointer on the audio thread, so it is checked
    // here and nowhere later.
    const handle = exports.engine_new(sampleRate, QUANTUM)
    if (handle === 0) {
      throw new Error(`engine_new refused sampleRate=${sampleRate}, maxFrames=${QUANTUM}`)
    }

    this.#exports = exports
    this.#instance = handle
    this.#rebuildViews()
  }

  /**
   * Every view over linear memory is created here and only here.
   *
   * `memory.grow` detaches every existing view, and the growth can happen
   * between two `process()` calls — inside `port.onmessage`, where this code
   * has no way to observe it. Pre-allocating the hot buffers removes the main
   * reason to grow; this rebuild covers the rest.
   */
  #rebuildViews(): void {
    const exports = this.#exports!
    const buffer = exports.memory.buffer
    this.#buffer = buffer
    this.#outL = new Float32Array(buffer, exports.engine_out_ptr(this.#instance, 0), QUANTUM)
    this.#outR = new Float32Array(buffer, exports.engine_out_ptr(this.#instance, 1), QUANTUM)
    this.#telemetry = new Uint32Array(
      buffer,
      exports.engine_telemetry_ptr(this.#instance),
      TELEMETRY_WORDS,
    )
  }

  #post(message: WorkletMessage): void {
    this.port.postMessage(message)
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const exports = this.#exports
    // Construction failed. Returning false ends the processor rather than
    // letting it be polled forever for silence it cannot explain.
    if (exports === null) return false

    // One reference comparison per quantum, which costs nothing, against a
    // failure mode that otherwise turns the output silent with no diagnostic.
    if (this.#buffer !== exports.memory.buffer) this.#rebuildViews()

    const output = outputs[0]
    if (output === undefined || output.length === 0) return true
    const frames = output[0].length

    if (!this.#firstQuantumReported) {
      this.#firstQuantumReported = true
      // This allocates, which is why it happens exactly once, on the first
      // block, before the stream has built up any real-time expectation. The
      // value is not observable from the native tests at all.
      this.#post({ type: 'first-quantum', frames })
    }

    exports.engine_process(this.#instance, frames, 0)

    output[0].set(this.#outL.subarray(0, frames))
    if (output.length > 1) output[1].set(this.#outR.subarray(0, frames))

    return true
  }
}

registerProcessor('engine', EngineProcessor)
