import { type EngineProcessorOptions, type Pong, processorName, type ToProcessor, type WorkletInfo } from '../protocol'
import { startAudioThread } from '../threads'
import { createEngineBlock, type RenderBlock } from './engine-block'

const pong: Pong = { _tag: 'Pong' }

class EngineProcessor extends AudioWorkletProcessor {
  private readonly render: RenderBlock
  private stopped = false

  constructor({ processorOptions }: { processorOptions: EngineProcessorOptions }) {
    super()
    const wasm = startAudioThread(processorOptions.module, processorOptions.memory)
    this.render = createEngineBlock(wasm, processorOptions)
    const answers: Record<ToProcessor['_tag'], () => void> = {
      // Between blocks, so only a processor that returns from them answers.
      Ping: () => this.port.postMessage(pong),
      Stop: () => {
        this.stopped = true
        // Nothing more comes either way: the browser can let the processor go with its node.
        this.port.close()
      }
    }
    this.port.onmessage = ({ data }: MessageEvent<ToProcessor>) => answers[data._tag]?.()
    const info: WorkletInfo = { hasPerformanceNow: 'performance' in globalThis }
    this.port.postMessage(info)
  }

  /** Until stopped: a node renders on while this says so, connected or not. */
  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    if (this.stopped) return false
    this.render(outputs[0], currentFrame)
    return true
  }
}

registerProcessor(processorName, EngineProcessor)
