// What only a JS-side test can check about the compiled engine.
//
// `scripts/build-wasm.sh` already guards the export surface on every build, so
// that list is deliberately not repeated here — two copies of it would drift,
// and the script's copy is the one CLAUDE.md tells you to update. The script
// stops at `WebAssembly.compile`, though. It never instantiates the module and
// never compares it against the TypeScript half. Both gaps close only in a
// browser today, and both present as a worklet that fails to construct with no
// reason attached.

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

import { PROTOCOL_VERSION } from '../src/audio/protocol'

const WASM_PATH = fileURLToPath(new URL('../public/engine.wasm', import.meta.url))

/** Same block size the worklet allocates for; Web Audio offers no other. */
const QUANTUM = 128

/** A rate the engine accepts. Not 48000 — nothing may assume that one. */
const SAMPLE_RATE = 44100

/**
 * The subset of the C ABI these tests call. The worklet declares the full
 * interface; when `initEngine` moves out of `processor.ts` into a module that
 * can be imported, this shape goes away and the real one is used instead.
 */
interface EngineExports {
  memory: WebAssembly.Memory
  engine_protocol_version(): number
  engine_new(sampleRate: number, maxFrames: number): number
  engine_free(instance: number): void
  engine_out_ptr(instance: number, channel: number): number
  engine_process(instance: number, frames: number, cmdCount: number): void
}

let compiled: WebAssembly.Module

beforeAll(async () => {
  let file: Buffer
  try {
    file = await readFile(WASM_PATH)
  } catch {
    // Loud rather than skipped. The artifact is gitignored, so on a fresh
    // clone it is genuinely absent — and a suite that quietly passes with
    // nothing to test is the failure this whole file exists to prevent.
    throw new Error(`${WASM_PATH} is missing. Build it with ./scripts/build-wasm.sh`)
  }

  // Copied into a plain view on the way in: Node types `Buffer` over
  // `ArrayBufferLike`, and `WebAssembly.compile` will not take a view that
  // might be sitting on a SharedArrayBuffer. Thirty kilobytes, once.
  compiled = await WebAssembly.compile(new Uint8Array(file))
})

describe('the compiled engine', () => {
  it('needs no imports, because the worklet has nothing to give it', () => {
    // `new WebAssembly.Instance(module, {})` in processor.ts passes an empty
    // import object and there is no second option: AudioWorkletGlobalScope has
    // no fetch, no loader, and nothing to bind. If Rust ever starts emitting
    // an import — a panic hook, an intrinsic the target does not lower — the
    // build stays green and the processor dies on construction.
    expect(WebAssembly.Module.imports(compiled)).toEqual([])
  })

  it('reports the protocol version this TypeScript build expects', () => {
    // The check that cannot be done on either side alone. Rust pins its own
    // byte layout with `wire_format_is_pinned`; this compares the number that
    // came out of the compiled module against the number JS will encode with.
    expect(instantiate().engine_protocol_version()).toBe(PROTOCOL_VERSION)
  })

  it('renders a silent quantum through the ABI as JS sees it', () => {
    // Every native test calls `Engine::process` directly. This is the first
    // one that goes the way the worklet goes — handle from `engine_new`,
    // pointers from `engine_out_ptr`, samples read back out of linear memory —
    // and so the first that would notice the ABI being wired up wrong.
    const engine = instantiate()

    const instance = engine.engine_new(SAMPLE_RATE, QUANTUM)
    expect(instance, 'engine_new refused arguments the worklet also passes').not.toBe(0)

    engine.engine_process(instance, QUANTUM, 0)

    for (const channel of [0, 1]) {
      const samples = new Float32Array(
        engine.memory.buffer,
        engine.engine_out_ptr(instance, channel),
        QUANTUM,
      )
      expect(samples.every(Number.isFinite), `channel ${channel} holds NaN or Inf`).toBe(true)
      // The transport starts stopped and no commands were passed, so the
      // metronome has nothing to sound. Exact zeros, not "quiet": a click
      // leaking out of a stopped transport is a timing bug, not a level one.
      expect(Array.from(samples).filter((s) => s !== 0)).toEqual([])
    }

    engine.engine_free(instance)
  })
})

function instantiate(): EngineExports {
  const instance = new WebAssembly.Instance(compiled, {})
  return instance.exports as unknown as EngineExports
}
