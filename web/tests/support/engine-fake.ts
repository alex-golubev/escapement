// A stand-in for the compiled engine. Outside `src/` because nothing that
// ships imports it. Typed as `EngineExports` and nothing less — that
// annotation, not the single definition, is what keeps it from drifting away
// from the ABI it stands in for.

import { PROTOCOL_VERSION } from '../../src/audio/protocol'
import { QUANTUM } from '../../src/audio/worklet-messages'
import type { EngineExports } from '../../src/worklet/engine'

/**
 * Records the exchange area holds, mirroring `CMD_CAPACITY` in ring.rs.
 *
 * Every test that stands in for the engine says this number, and saying it is a
 * claim about a build nothing on this side compiles — so `engine-abi.spec.ts`
 * asks the compiled engine and holds it against this. Nothing that ships needs
 * the guard: the worklet reads `engine_cmd_capacity` and sizes its view from
 * what it gets. What a wrong number here breaks is the tests' account of the
 * engine — an overflow test that no longer overflows where the real drain does,
 * and passes.
 */
export const CMD_CAPACITY = 256

/**
 * Where the fake claims its buffers are, laid out the way the real engine lays
 * them out — so a view built over it is wrong in the same ways.
 */
export const FAKE_LAYOUT = {
  quantum: QUANTUM,
  outL: 0,
  outR: QUANTUM * Float32Array.BYTES_PER_ELEMENT,
  telemetry: 8192,
  /**
   * Past the exchange area, which ends at 8192. The real arena is allocated
   * rather than placed, so this address stands for nothing in particular — what
   * it has to be is somewhere a view can be built, so that a caller writing a
   * kit through it is doing what it would really do.
   */
  arena: 16384,
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
    engine_cmd_capacity: () => CMD_CAPACITY,
    engine_telemetry_ptr: () => FAKE_LAYOUT.telemetry,
    engine_process: () => undefined,
    // An engine that grants and accepts, which is what "behaves" means for
    // these two. Neither grows memory and neither looks at what was written —
    // a fake that did would be a second sampler. The tests that need a refusal,
    // or a reservation that detaches the views, pass their own through
    // `overrides`, which is the shape those cases want anyway: one behaviour
    // per test rather than a switchboard here.
    engine_bank_reserve: () => FAKE_LAYOUT.arena,
    engine_sample_commit: () => 0,
    ...overrides,
  }
}
