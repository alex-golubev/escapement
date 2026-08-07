// The hot path: 375 blocks a second at 48 kHz, allocating nothing, locking
// nothing, logging nothing, throwing nothing.
//
// Plain functions rather than methods, because `AudioWorkletProcessor` cannot
// be constructed outside a browser and anything in the class is untestable.

import { buildViews } from './engine'
import type { EngineState } from './engine'
import { drainCommands } from './exchange'

/**
 * Rebuild after the `memory.grow` detach described in `buildViews`. The
 * unchanged case returns the same object, so the path taken every quantum
 * allocates nothing.
 */
export function refreshViews(state: EngineState): EngineState {
  if (state.views.buffer === state.exports.memory.buffer) return state
  return {
    ...state,
    views: buildViews(state.exports, state.instance, state.maxFrames, state.cmdCapacity),
  }
}

/**
 * Render one block into the host's output, returning the frame count — zero
 * when there was nothing to fill. A number and not a result object, which here
 * would be an allocation per quantum.
 */
export function renderQuantum(state: EngineState, outputs: Float32Array[][]): number {
  const output = outputs[0]
  if (output === undefined || output.length === 0) return 0

  const left = output[0]
  const frames = left.length

  // Drained here and not before the early return above: a command copied into
  // the exchange area without an `engine_process` to follow is a command
  // consumed and thrown away. Left in the ring it merely waits.
  const commands = drainCommands(state.ring, state.views.cmd)

  state.exports.engine_process(state.instance, frames, commands)

  copyChannel(left, state.views.outL)
  if (output.length > 1) copyChannel(output[1], state.views.outR)

  return frames
}

/**
 * `subarray` allocates a view object, so the whole-view branch keeps the block
 * Web Audio actually renders off that path. The trimming branch stays because
 * "always 128 frames" is the host's property, not this code's.
 */
function copyChannel(destination: Float32Array, source: Float32Array): void {
  if (destination.length >= source.length) destination.set(source)
  else destination.set(source.subarray(0, destination.length))
}
