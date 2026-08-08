// The hot path: 375 blocks a second at 48 kHz, allocating nothing, locking
// nothing, logging nothing, throwing nothing.
//
// Plain functions rather than methods, because `AudioWorkletProcessor` cannot
// be constructed outside a browser and anything in the class is untestable.

import { buildViews } from './engine'
import type { EngineState } from './engine'
import { drainCommands, publishTelemetry } from './exchange'

/**
 * Rebuild after the `memory.grow` detach described in `buildViews`. The
 * unchanged case returns the same object, so the path taken every quantum
 * allocates nothing.
 *
 * `buildViews` throws on an engine whose pointers do not fit the memory behind
 * them, and there is no catch here on purpose: growth only ever makes that
 * memory larger, and the pointers do not move (`lib.rs::buffers_never_move`),
 * so a rebuild that fits at init fits forever. An engine that would throw here
 * threw in `openEngine`, where the failure has a name.
 */
export function refreshViews(state: EngineState): EngineState {
  if (state.views.buffer === state.exports.memory.buffer) return state
  return {
    ...state,
    views: buildViews(state.exports, state.instance, state.maxFrames, state.cmdCapacity),
  }
}

/**
 * Render one block into the host's output, returning the size of the block the
 * host handed over — zero when there was nothing to fill. A number and not a
 * result object, which here would be an allocation per quantum.
 *
 * What the engine is asked for is that size capped at `maxFrames`, which is
 * what it was allocated for. Web Audio renders 128 frames and offers no other
 * size, so today the cap never binds; if a host ever hands over more, the
 * engine clamps identically on its own side and the honest number is the one
 * passed across the ABI. The block then comes back part-rendered, and the
 * count returned here is what says so — `first-quantum` carries it to the page,
 * which holds it against 128.
 */
export function renderQuantum(state: EngineState, outputs: Float32Array[][]): number {
  const output = outputs[0]
  // Answers to the host, not to the type. `Float32Array[][]` says this element
  // is always there; the host says nothing of the kind, and a disconnected
  // output arrives as no channels at all. Neither tool backs the check as
  // configured — `noUncheckedIndexedAccess` would require it and is off,
  // `no-unnecessary-condition` would call it dead and is off too (both
  // decisions are written down where they are made) — so what holds it up is a
  // test: `renderQuantum(state, [])` takes this branch, and asserts the engine
  // was left alone.
  if (output === undefined || output.length === 0) return 0

  const left = output[0]
  const block = left.length
  const frames = block <= state.maxFrames ? block : state.maxFrames

  // Drained here and not before the early return above: a command copied into
  // the exchange area without an `engine_process` to follow is a command
  // consumed and thrown away. Left in the ring it merely waits.
  const commands = drainCommands(state.ring, state.views.cmd)

  state.exports.engine_process(state.instance, frames, commands)

  copyChannel(left, state.views.outL)
  if (output.length > 1) copyChannel(output[1], state.views.outR)

  // Last, and only on a quantum that actually rendered: `engine_process` wrote
  // this block, and publishing without one would republish the quantum before
  // under a fresh sequence number — a reader would see the position stand
  // still and have no way to tell that from a stopped transport.
  publishTelemetry(state.ring, state.views.telemetry)

  return block
}

/**
 * `subarray` allocates a view object, so the equal-length branch — the only one
 * Web Audio takes today — keeps the block that is actually rendered off that
 * path. The other two stay because "always 128 frames" is the host's property,
 * not this code's, and they fail in opposite directions: a shorter block is
 * trimmed, a longer one is filled as far as the engine rendered and zeroed the
 * rest. Zeroed rather than left alone, because a buffer the host reuses would
 * otherwise repeat the tail of the previous block as sound.
 */
function copyChannel(destination: Float32Array, source: Float32Array): void {
  if (destination.length === source.length) {
    destination.set(source)
  } else if (destination.length < source.length) {
    destination.set(source.subarray(0, destination.length))
  } else {
    destination.set(source)
    destination.fill(0, source.length)
  }
}
