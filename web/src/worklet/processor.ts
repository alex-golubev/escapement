// The worklet half of the engine: what only a browser can run — the Web Audio
// class shape, the port, and the render loop. Bring-up is in engine.ts and the
// hot path in render.ts, both so that they can be tested.
//
// Bundled standalone by scripts/build-worklet.sh. It must not depend on
// anything that survives bundling as an import — AudioWorkletGlobalScope has
// no module loader — but esbuild resolves the imports below at build time, so
// nothing is imported at runtime.

import { describeInitError, initEngine } from './engine'
import type { EngineState } from './engine'
import { refreshViews, renderQuantum } from './render'
import { QUANTUM } from '../audio/worklet-messages'
import type { WorkletMessage } from '../audio/worklet-messages'

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
  #state: EngineState | null = null
  #firstQuantumReported = false

  constructor(options: AudioWorkletNodeOptions) {
    super()
    const started = initEngine(options.processorOptions, sampleRate, QUANTUM)

    if (!started.ok) {
      // Reported, not thrown, and deliberately so. A throw here reaches the
      // page as a bare `processorerror` event with no reason attached; this
      // message is the only way the cause crosses the thread boundary.
      this.#post({ type: 'failed', message: describeInitError(started.error) })
      return
    }

    this.#state = started.value
    this.#post({
      type: 'ready',
      sampleRate,
      protocolVersion: started.value.protocolVersion,
    })
  }

  #post(message: WorkletMessage): void {
    this.port.postMessage(message)
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    // Construction failed. Returning false ends the processor rather than
    // letting it be polled forever for silence it cannot explain.
    if (this.#state === null) return false

    const state = refreshViews(this.#state)
    this.#state = state

    const frames = renderQuantum(state, outputs)

    if (frames > 0 && !this.#firstQuantumReported) {
      this.#firstQuantumReported = true
      // This allocates, which is why it happens exactly once, on the first
      // block, before the stream has built up any real-time expectation. The
      // value is not observable from the native tests at all.
      this.#post({ type: 'first-quantum', frames })
    }

    return true
  }
}

registerProcessor('engine', EngineProcessor)
