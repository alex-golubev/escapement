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
// The block size the worklet allocates the engine for, from the module both
// threads read it out of.
import { QUANTUM } from '../src/audio/worklet-messages'
import { CMD_CAPACITY } from './support/engine-fake'
// The interface the worklet itself declares, not a copy of the parts used
// here: a second description of the ABI would drift from the first, and this
// file exists to catch drift. The telemetry indices arrive the same way, and
// from the worklet's side of the tree for the same reason they live there: the
// block is in linear memory, which only the audio thread ever addresses.
import type { EngineExports } from '../src/worklet/engine'
import {
  TELEMETRY_PEAK_L,
  TELEMETRY_PEAK_R,
  TELEMETRY_TRANSPORT_HI,
  TELEMETRY_TRANSPORT_LO,
  TELEMETRY_WORDS,
} from '../src/worklet/telemetry-block'

const WASM_PATH = fileURLToPath(new URL('../public/engine.wasm', import.meta.url))

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

  it('holds the exchange area the rest of the suite stands in for', () => {
    // Three test-side stand-ins render or drain against a 256-record exchange
    // area and call it what the engine reports. Until this line nothing asked
    // the engine, and the claim was free.
    //
    // Nothing that ships depends on it — the worklet reads
    // `engine_cmd_capacity` and sizes its view from the answer, which is the
    // whole reason a mismatch here is quiet. What it would spoil is the tests'
    // account of the engine: `drainCommands` overflowing at 256 is what the
    // exchange-area tests are about, and against a 512-record engine they would
    // describe an overflow that never happens and pass every time.
    const engine = instantiate()
    const instance = engine.engine_new(SAMPLE_RATE, QUANTUM)
    expect(instance).not.toBe(0)

    expect(engine.engine_cmd_capacity(instance)).toBe(CMD_CAPACITY)

    engine.engine_free(instance)
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

  it('scales its output by a master gain that crossed the wire', () => {
    // The one command of the eight whose effect is observable from this side.
    // Track gain, pan and the pattern are stored in the engine and reach no
    // sample yet — there are no voices — so no assertion here could tell a
    // working decode from a discarded one, and the native tests hold those
    // instead. Worth knowing precisely because of the mutation this file
    // exists to catch: an opcode numbered differently in the two languages is
    // caught here for the master gain and by nothing at all for the rest,
    // until the sampler gives them an audible effect.
    //
    // This one goes further than the tempo test above, which shows a number
    // surviving the crossing. A gain that arrived as an integer, or landed in
    // arg_a, or was read from the wrong offset would still be *a* number; only
    // scaling the samples by exactly it rules that out.
    const BPM = 600
    /** Past the 10 ms parameter glide, so this measures the gain, not the ramp. */
    const SETTLED = 1_000

    function peakAt(gain: number): number {
      const engine = instantiate()
      const instance = engine.engine_new(SAMPLE_RATE, QUANTUM)
      expect(instance).not.toBe(0)

      const exchange = new DataView(
        engine.memory.buffer,
        engine.engine_cmd_ptr(instance),
        engine.engine_cmd_capacity(instance) * COMMAND_SIZE,
      )
      writeCommand(exchange, 0, { op: 'set-master-gain', gain }, 0)
      writeCommand(exchange, COMMAND_SIZE, { op: 'set-bpm', bpm: BPM }, 0)
      writeCommand(exchange, 2 * COMMAND_SIZE, { op: 'play' }, 0)

      const samples = render(engine, instance, 100, 3).subarray(SETTLED)
      engine.engine_free(instance)
      return samples.reduce((peak, sample) => Math.max(peak, Math.abs(sample)), 0)
    }

    const unity = peakAt(1)
    expect(unity, 'the metronome was silent, so there was nothing to scale').toBeGreaterThan(0)
    // Exactly half: 0.5 is a power of two, so scaling by it is lossless, and a
    // tolerance here would accept a gain that merely resembled the one sent.
    expect(peakAt(0.5)).toBe(unity / 2)
    // And exactly zero, which is a property of the ramp rather than of the
    // gain: a parameter that converged on its target without reaching it would
    // leave an inaudible residue here, and every "is it silent" check
    // downstream would have to become a tolerance.
    expect(peakAt(0)).toBe(0)
  })

  it('lays its telemetry block out where protocol.ts says it does', () => {
    // The half of the contract going the other way, and the one nothing used
    // to hold against the compiled engine. The record format is pinned in both
    // languages and crossed end to end above; the telemetry block is mirrored
    // in protocol.ts by hand, and no version word covers it — `PROTOCOL_VERSION`
    // is about the record layout and the opcode set. Reorder two words in
    // engine.rs and every other test in this repository stays green while the
    // page shows a position that is a peak.
    const engine = instantiate()
    const instance = engine.engine_new(SAMPLE_RATE, QUANTUM)
    expect(instance).not.toBe(0)

    const exchange = new DataView(
      engine.memory.buffer,
      engine.engine_cmd_ptr(instance),
      engine.engine_cmd_capacity(instance) * COMMAND_SIZE,
    )
    writeCommand(exchange, 0, { op: 'set-bpm', bpm: 120 }, 0)
    writeCommand(exchange, COMMAND_SIZE, { op: 'play' }, 0)

    // The same bytes twice, exactly as the worklet and the page see them: the
    // block is copied word by word into the ring and the peaks are read back
    // through a float view over it.
    const telemetry = engine.engine_telemetry_ptr(instance)
    const words = new Uint32Array(engine.memory.buffer, telemetry, TELEMETRY_WORDS)
    const floats = new Float32Array(engine.memory.buffer, telemetry, TELEMETRY_WORDS)

    // Before the first block, so that everything below is a change this test
    // caused rather than whatever happened to be at that address.
    expect(Array.from(words), 'the block is not zeroed at construction').toEqual([0, 0, 0, 0])

    render(engine, instance, 1, 2)
    const struck = floats[TELEMETRY_PEAK_L]

    expect(words[TELEMETRY_TRANSPORT_LO]).toBe(QUANTUM)
    expect(words[TELEMETRY_TRANSPORT_HI], 'the high word is not the position').toBe(0)
    // A meter reading, not a position and not a count: bounded by one, and
    // greater than zero because Play landed inside this very block and the
    // metronome struck a beat in it.
    expect(struck).toBeGreaterThan(0)
    expect(struck).toBeLessThanOrEqual(1)
    // The same word read as the integer it is not, which is what makes the
    // float above a reinterpretation rather than a number Rust wrote out: any
    // meter reading in the bits of an f32 is an enormous u32.
    expect(words[TELEMETRY_PEAK_L], 'the peak word is not f32 bits').toBeGreaterThan(1)
    // Both channels carry the same metronome at this milestone, so this pins
    // that the second peak is a peak — not that L and R are the right way
    // round. Nothing in M0 can tell those two apart, and a test that claimed to
    // would be claiming more than it checks.
    expect(floats[TELEMETRY_PEAK_R]).toBe(struck)

    const QUIET = 20
    render(engine, instance, QUIET, 0)

    expect(words[TELEMETRY_TRANSPORT_LO]).toBe((QUIET + 1) * QUANTUM)
    // Falling, and still sounding. The click is over within some 8 ms while
    // the meter falls by `PEAK_FALL_PER_SECOND` — so a word that held still
    // here would be something other than the meter, and one that dropped to
    // zero would be the raw block level.
    expect(floats[TELEMETRY_PEAK_L]).toBeLessThan(struck)
    expect(floats[TELEMETRY_PEAK_L]).toBeGreaterThan(0)

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
