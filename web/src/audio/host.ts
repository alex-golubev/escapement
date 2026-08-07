// Main-thread setup for the audio engine: compile the module, load the
// worklet, hand the two together and connect the result to the speakers.

import type { ReadyMessage, WorkletMessage } from './worklet-messages'

const WASM_URL = '/engine.wasm'
const WORKLET_URL = '/worklet/processor.js'

export interface EngineHandle {
  context: AudioContext
  node: AudioWorkletNode
  /** The rate the context actually settled on, which is not always 48 kHz. */
  sampleRate: number
  /** Reported by the compiled engine, not read from any TypeScript constant. */
  protocolVersion: number
}

/**
 * Start the engine and connect it to the destination.
 *
 * Must be called from a user gesture. Built outside one, the context stays
 * `suspended` under the autoplay policy: nothing throws, nothing logs, and no
 * sound ever arrives.
 */
export async function startEngine(
  onMessage?: (message: WorkletMessage) => void,
): Promise<EngineHandle> {
  const context = new AudioContext()

  try {
    // Compiling here rather than inside the worklet is not a preference:
    // AudioWorkletGlobalScope has neither fetch nor XMLHttpRequest. A compiled
    // WebAssembly.Module does survive structured clone, so it can be handed
    // over in processorOptions and instantiated synchronously on the far side.
    //
    // The two loads do not depend on each other, so they overlap.
    const [module] = await Promise.all([
      WebAssembly.compileStreaming(fetch(WASM_URL)),
      context.audioWorklet.addModule(WORKLET_URL),
    ])

    const node = new AudioWorkletNode(context, 'engine', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { module },
    })

    const ready = await waitForReady(node, onMessage)

    node.connect(context.destination)
    await context.resume()

    return {
      context,
      node,
      sampleRate: ready.sampleRate,
      protocolVersion: ready.protocolVersion,
    }
  } catch (error) {
    // A context left behind on a failed start holds an audio device open for
    // the lifetime of the page.
    await context.close()
    throw error
  }
}

function waitForReady(
  node: AudioWorkletNode,
  onMessage?: (message: WorkletMessage) => void,
): Promise<ReadyMessage> {
  return new Promise((resolve, reject) => {
    node.port.onmessage = (event: MessageEvent<WorkletMessage>) => {
      const message = event.data
      onMessage?.(message)
      if (message.type === 'ready') resolve(message)
      else if (message.type === 'failed') reject(new Error(message.message))
    }

    // Covers whatever escapes before the processor can describe its own
    // failure — this event carries no reason, which is exactly why the
    // processor reports by message instead of throwing.
    node.onprocessorerror = () =>
      reject(new Error('The worklet processor threw before it could report a reason'))
  })
}
