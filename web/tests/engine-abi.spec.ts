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

import { COMMAND_SIZE, PROTOCOL_VERSION, writeCommand } from '../src/audio/protocol'
// The interface the worklet itself declares, not a copy of the parts used
// here: a second description of the ABI would drift from the first, and this
// file exists to catch drift.
import type { EngineExports } from '../src/worklet/engine'

const WASM_PATH = fileURLToPath(new URL('../public/engine.wasm', import.meta.url))

/** Same block size the worklet allocates for; Web Audio offers no other. */
const QUANTUM = 128

/** A rate the engine accepts. Not 48000 — nothing may assume that one. */
const SAMPLE_RATE = 44100

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

  it('takes a TypeScript-encoded command and runs the transport by it', () => {
    // The half of the two-file contract that neither side can check alone.
    // Rust pins its byte layout in `wire_format_is_pinned` and protocol.spec.ts
    // pins the mirror of it, but both are one language asserting about itself.
    // Here the encoder that ships writes bytes the decoder that ships reads,
    // through the same exchange area the worklet copies into.
    const engine = instantiate()
    const instance = engine.engine_new(SAMPLE_RATE, QUANTUM)
    expect(instance).not.toBe(0)

    // 44100 × 60 / 147 is exactly 18 000 samples, so the assertion below can
    // be an equality rather than a tolerance.
    const BPM = 147
    const samplesPerBeat = (SAMPLE_RATE * 60) / BPM

    const exchange = new DataView(
      engine.memory.buffer,
      engine.engine_cmd_ptr(instance),
      engine.engine_cmd_capacity(instance) * COMMAND_SIZE,
    )
    writeCommand(exchange, 0, { op: 'set-bpm', bpm: BPM }, 0)
    writeCommand(exchange, COMMAND_SIZE, { op: 'play' }, 0)

    const onsets = clickOnsets(render(engine, instance, 200, 2))

    expect(onsets, 'expected exactly two clicks in the rendered window').toHaveLength(2)
    expect(onsets[0], 'Play did not take effect in the quantum it arrived in').toBeLessThan(
      QUANTUM,
    )
    // The one number that could only have come through the wire: a tempo
    // dropped, misread as another type, or reassembled from the wrong offset
    // puts this beat somewhere else entirely.
    expect(onsets[1] - onsets[0], 'the tempo did not survive the crossing').toBe(samplesPerBeat)

    engine.engine_free(instance)
  })
})

function instantiate(): EngineExports {
  const instance = new WebAssembly.Instance(compiled, {})
  return instance.exports as unknown as EngineExports
}

/** Render `quanta` blocks, passing the command count on the first one only. */
function render(
  engine: EngineExports,
  instance: number,
  quanta: number,
  cmdCount: number,
): Float32Array {
  const out = new Float32Array(quanta * QUANTUM)
  const left = new Float32Array(
    engine.memory.buffer,
    engine.engine_out_ptr(instance, 0),
    QUANTUM,
  )

  for (let block = 0; block < quanta; block += 1) {
    engine.engine_process(instance, QUANTUM, block === 0 ? cmdCount : 0)
    out.set(left, block * QUANTUM)
  }
  return out
}

/**
 * The first sample of each click.
 *
 * Blocks are separated at quantum resolution before the exact frame is taken,
 * and that order matters: a click is a decaying sine and passes through zero
 * on its way, but never for a whole block — while between beats the engine
 * gates the voice off and the samples are exact zeros for thousands of frames.
 */
function clickOnsets(samples: Float32Array): number[] {
  const onsets: number[] = []
  let silent = true

  for (let start = 0; start < samples.length; start += QUANTUM) {
    const block = samples.subarray(start, start + QUANTUM)
    const sounding = block.some((sample) => sample !== 0)
    if (sounding && silent) onsets.push(start + block.findIndex((sample) => sample !== 0))
    silent = !sounding
  }
  return onsets
}
