import { RingBuffer } from 'ringbuf.js'
import { panicTextTaker, withPanicText } from '../panic-text'
import { blockFrames, channelCount, type EngineProcessorOptions } from '../protocol'
import { engineTelemetryWords, telemetryWriter } from '../telemetry'
import type { EngineExports } from '../threads'

/** Renders into `channels` the block that starts at the context's `frame`. */
export type RenderBlock = (channels: ReadonlyArray<Float32Array>, frame: number) => void

/**
 * Returns what the worklet runs every block; it allocates nothing. `wasm` must have taken its place already. A trap
 * comes out with what the panic said, if the engine panicked.
 */
export const createEngineBlock = (
  wasm: EngineExports,
  { memory, engine, commandRing, eventRing, telemetryBoard }: EngineProcessorOptions
): RenderBlock => {
  const commands = new RingBuffer(commandRing, Uint8Array)
  const events = new RingBuffer(eventRing, Uint8Array)
  const publishTelemetry = telemetryWriter(telemetryBoard)
  const inputCapacity = wasm.engine_input_capacity()
  const eventCapacity = wasm.engine_event_capacity()
  // The engine's buffers never move, and shared memory is never detached: these views outlive any growth.
  // Addresses come back as signed numbers.
  const buffer = memory.buffer
  const views = {
    input: new Uint8Array(buffer, wasm.engine_input(engine) >>> 0, inputCapacity),
    output: Array.from(
      { length: channelCount },
      (_, c) => new Float32Array(buffer, wasm.engine_output(engine, c) >>> 0, blockFrames)
    ),
    events: new Uint8Array(buffer, wasm.engine_events(engine) >>> 0, eventCapacity),
    telemetry: new Uint32Array(buffer, wasm.engine_telemetry(engine) >>> 0, engineTelemetryWords)
  }

  const panicText = panicTextTaker(memory, wasm.engine_panic_text() >>> 0)

  const render: RenderBlock = (channels, frame) => {
    // The engine's buffers hold exactly one render quantum per channel. Channels first: there may be none.
    if (channels.length !== channelCount || channels[0].length !== blockFrames) {
      throw new Error(
        `Render quantum of ${channels.length} × ${channels[0]?.length ?? 0} frames, ` +
          `the engine renders ${channelCount} × ${blockFrames}`
      )
    }
    const waiting = wasm.engine_input_len(engine)
    const received = commands.pop(views.input, inputCapacity - waiting, waiting)
    // Only events that fit are handed out, and the page can only add room meanwhile.
    const eventBytes = wasm.engine_process(engine, blockFrames, received, events.availableWrite())
    for (let c = 0; c < channels.length; c++) channels[c].set(views.output[c])
    if (eventBytes > 0) events.push(views.events, eventBytes)
    publishTelemetry(views.telemetry, frame)
  }
  return (channels, frame) => {
    try {
      render(channels, frame)
    } catch (error) {
      throw withPanicText(error, panicText)
    }
  }
}
