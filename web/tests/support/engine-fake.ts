// A stand-in for the compiled engine. Outside `src/` because nothing that
// ships imports it. Typed as `EngineExports` and nothing less — that
// annotation, not the single definition, is what keeps it from drifting away
// from the ABI it stands in for.

import { PROTOCOL_VERSION } from '../../src/audio/protocol'
import type { EngineExports } from '../../src/worklet/engine'

/**
 * Where the fake claims its buffers are, laid out the way the real engine lays
 * them out — so a view built over it is wrong in the same ways.
 */
export const FAKE_LAYOUT = {
  quantum: 128,
  outL: 0,
  outR: 128 * Float32Array.BYTES_PER_ELEMENT,
  telemetry: 8192,
} as const

/** An engine that behaves, with one page of memory — 64 KiB — behind it. */
export function fakeEngine(overrides: Partial<EngineExports> = {}): EngineExports {
  const memory = new WebAssembly.Memory({ initial: 1 })
  return {
    memory,
    engine_protocol_version: () => PROTOCOL_VERSION,
    engine_new: () => 1,
    engine_free: () => undefined,
    engine_out_ptr: (_instance, channel) =>
      channel === 0 ? FAKE_LAYOUT.outL : FAKE_LAYOUT.outR,
    engine_cmd_ptr: () => 4096,
    engine_cmd_capacity: () => 256,
    engine_telemetry_ptr: () => FAKE_LAYOUT.telemetry,
    engine_process: () => undefined,
    ...overrides,
  }
}
