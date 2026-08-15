// What only a JS-side test can check about the compiled engine.
//
// `scripts/build-wasm.sh` already guards the export surface on every build, so
// that list is deliberately not repeated here — two copies of it would drift,
// and the script's copy is the one CLAUDE.md tells you to update. The script
// stops at `WebAssembly.compile`, though. It never instantiates the module and
// never compares it against the TypeScript half. Both gaps close only in a
// browser today, and both present as a worklet that fails to construct with no
// reason attached.
//
// **Every opcode is checked here, and that is new.** For as long as no kit
// could be put into the engine from this side, eight of the ten reached a
// sample only through one and no assertion could tell a working decode from a
// discarded one — so an opcode numbered differently in the two languages was
// caught for two of them and by nothing anywhere for the rest. Loading a kit is
// what closed it; `withKit` below is that load, and the impulse it puts in is
// what makes a rendered block readable as arithmetic.

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

import { COMMAND_SIZE, PROTOCOL_VERSION, STEPS, writeCommand } from '../src/audio/protocol'
import type { Command } from '../src/audio/protocol'
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
  TELEMETRY_STEP,
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
    const count = write(exchange, { op: 'set-bpm', bpm: BPM }, { op: 'play' })

    const onsets = clickOnsets(render(engine, instance, 200, count).left)

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

  it('stops sounding the metronome when told to across the wire', () => {
    // The one opcode here whose whole effect is silence, which is why it needs
    // no kit and why it was the second to become checkable, long before there
    // was one to load.
    //
    // The negative alone would be worthless: an opcode misnumbered into
    // nothing, or a `value` read from the wrong offset, produces the same
    // silence as one that worked. So both halves are rendered from the same
    // engine, and the claim is the difference between them.
    const engine = instantiate()
    const instance = engine.engine_new(SAMPLE_RATE, QUANTUM)
    expect(instance).not.toBe(0)

    const exchange = new DataView(
      engine.memory.buffer,
      engine.engine_cmd_ptr(instance),
      engine.engine_cmd_capacity(instance) * COMMAND_SIZE,
    )
    const started = write(exchange, { op: 'set-bpm', bpm: 600 }, { op: 'play' })

    const sounding = render(engine, instance, 20, started).left
    expect(sounding.some((sample) => sample !== 0)).toBe(true)

    const off = write(exchange, { op: 'set-metronome', enabled: false })
    // Past the tail of the click that was already sounding when the switch
    // arrived: switching off silences the next beat, not this one.
    render(engine, instance, 20, off)

    const silent = render(engine, instance, 20, 0).left
    expect(Array.from(silent).filter((sample) => sample !== 0)).toEqual([])

    engine.engine_free(instance)
  })

  it('scales its output by a master gain that crossed the wire', () => {
    // The only knob that scales everything at once, and so the only one
    // measurable without a kit. Everything below it addresses a track and waits
    // on `withKit`.
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
      const count = write(
        exchange,
        { op: 'set-master-gain', gain },
        { op: 'set-bpm', bpm: BPM },
        { op: 'play' },
      )

      const samples = render(engine, instance, 100, count).left.subarray(SETTLED)
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

  it('grows linear memory to hold a kit, and leaves the addresses where they were', () => {
    // Both halves of what `refreshViews` is written against, and until now
    // neither had been seen outside a browser session. A reservation replaces
    // the buffer every view sits on, so the views die; the pointers behind them
    // do not move, which is why rebuilding from the stored addresses is enough
    // and why nothing has to be re-asked of the engine.
    const engine = instantiate()
    const instance = engine.engine_new(SAMPLE_RATE, QUANTUM)
    expect(instance).not.toBe(0)

    const before = engine.memory.buffer
    const out = engine.engine_out_ptr(instance, 0)
    const view = new Float32Array(before, out, QUANTUM)

    // Eight megabytes: more than any module starts with, so the growth is not
    // left to whatever slack the allocator happened to have.
    expect(engine.engine_bank_reserve(instance, 2_000_000)).not.toBe(0)

    expect(engine.memory.buffer, 'the arena fitted without growing').not.toBe(before)
    expect(view.byteLength, 'a view built before the growth still reads').toBe(0)
    expect(engine.engine_out_ptr(instance, 0), 'a hot-path buffer moved').toBe(out)

    engine.engine_free(instance)
  })

  it('strikes the slot the pad addressed, with what was written into the arena', () => {
    // The first opcode here that reaches a sample, and it needs no transport: a
    // pad sounds against a stopped one, which is what makes it a thing of its
    // own rather than a shortcut to a step.
    //
    // Which slot it reached is read off the height rather than asserted as a
    // level. Slot 3 holds an eighth of what slot 0 holds, so a track number
    // that arrived as zero — the value a dropped `arg_a` takes — comes back
    // eight times too loud, while nothing here has to know what a strike is
    // worth in the first place.
    const { engine, instance, exchange } = withKit()

    const pad = (track: number): number => {
      const count = write(exchange, { op: 'trigger-track', track, velocity: 0.5 })
      const { left } = render(engine, instance, 1, count)
      expect(strikes(left), `track ${track} did not strike exactly once`).toEqual([0])
      return left[0]
    }

    const loudest = pad(0)
    expect(loudest, 'the kit was loaded but nothing sounded').toBeGreaterThan(0)
    expect(pad(3), 'the track did not survive the crossing').toBe(loudest / 8)

    engine.engine_free(instance)
  })

  it('strikes the cells the grid was given, at the steps and velocities they carry', () => {
    // `SetStep` is the only command addressing through both `arg_a` and
    // `arg_b`, and each of its four fields can be wrong on its own. One render
    // reads all four: where the strikes fall is the step, how they compare is
    // the velocity, and how tall they are is the track — through the slot
    // heights, as above.
    //
    // Positions are asserted in steps and not in samples, which is not
    // shorthand: turning one into the other takes the divisions per beat, an
    // engine constant deliberately never mirrored on this side. So the spacing
    // the engine itself produced is the unit, and every onset is held against
    // it — including the last, which is the first cell coming round again and
    // is the only thing here that says how long the pattern is.
    const { engine, instance, exchange } = withKit()

    const count = write(
      exchange,
      { op: 'set-metronome', enabled: false },
      { op: 'set-bpm', bpm: 588 },
      { op: 'set-step', track: 3, step: 2, velocity: 0.5 },
      { op: 'set-step', track: 3, step: 6, velocity: 0.25 },
      { op: 'set-step', track: 1, step: 10, velocity: 0.5 },
      { op: 'play' },
    )

    const { left } = render(engine, instance, 200, count)
    const at = strikes(left)
    // Three cells, and the window is long enough for the first two of them to
    // come round again.
    expect(at, 'the grid did not strike five times in this window').toHaveLength(5)

    const step = (at[1] - at[0]) / 4
    expect(at[0], 'the first cell is not on step 2').toBe(2 * step)
    expect(at[2], 'the third cell is not on step 10').toBe(10 * step)
    expect(at[3], `the pattern did not come round after ${STEPS} steps`).toBe((STEPS + 2) * step)
    expect(at[4], 'the second lap does not match the first').toBe((STEPS + 6) * step)

    // Exact ratios of powers of two, so these are equalities: the velocities
    // differ by two and the slots by eight in level, four apart in the pair
    // asked about here.
    expect(left[at[0]] / left[at[1]], 'the velocity did not survive').toBe(2)
    expect(left[at[2]] / left[at[0]], 'the track did not survive').toBe(4)

    engine.engine_free(instance)
  })

  it('empties the grid when told to across the wire', () => {
    const { engine, instance, exchange } = withKit()
    const count = write(
      exchange,
      { op: 'set-metronome', enabled: false },
      { op: 'set-bpm', bpm: 588 },
      { op: 'set-step', track: 3, step: 2, velocity: 0.5 },
      { op: 'set-step', track: 1, step: 10, velocity: 0.5 },
      { op: 'play' },
    )

    // Rendered as far as the first cell and no further, so that the window
    // after the command is one the pattern was still due to strike in. Silence
    // over a window that was empty anyway would pass with the opcode dropped.
    const before = render(engine, instance, 60, count).left
    expect(strikes(before), 'the fixture never struck').toHaveLength(1)

    const cleared = write(exchange, { op: 'clear-pattern' })
    expect(strikes(render(engine, instance, 140, cleared).left)).toEqual([])

    engine.engine_free(instance)
  })

  it('scales a track by a gain that crossed the wire', () => {
    const { engine, instance, exchange } = withKit()

    const pad = (): number => {
      const count = write(exchange, { op: 'trigger-track', track: 2, velocity: 0.5 })
      return render(engine, instance, 1, count).left[0]
    }

    const unity = pad()
    expect(unity).toBeGreaterThan(0)

    // Sent, and then given room: a track's knobs are ramped over ten
    // milliseconds, so a strike in the block the command arrives in would
    // measure the ramp rather than the value. The track is not zero for the
    // same reason the pad test uses three — an `arg_a` lost on the way leaves
    // this one at unity.
    const count = write(exchange, { op: 'set-track-gain', track: 2, gain: 0.5 })
    render(engine, instance, 20, count)

    expect(pad(), 'the gain did not survive the crossing').toBe(unity / 2)

    engine.engine_free(instance)
  })

  it('pans a track to the side the wire named, and to the far edge exactly', () => {
    // The sign is what this is for. A pan that arrived negated is a defect
    // nobody hears and every mix has, and no other test here would see it: the
    // level is unchanged, both channels still sound, and only which one is
    // louder is wrong.
    //
    // The far edge is an exact zero by the pan law's own promise — the root
    // form is exact and mirrored at both ends, which is why it was chosen over
    // the trigonometric one — so these are equalities rather than thresholds.
    const { engine, instance, exchange } = withKit()

    const padded = (pan: number): Rendered => {
      const set = write(exchange, { op: 'set-track-pan', track: 4, pan })
      render(engine, instance, 20, set)
      const count = write(exchange, { op: 'trigger-track', track: 4, velocity: 0.5 })
      return render(engine, instance, 1, count)
    }

    const hardLeft = padded(-1)
    expect(hardLeft.left[0]).toBeGreaterThan(0)
    expect(hardLeft.right[0], 'a hard left leaked into the right channel').toBe(0)

    const hardRight = padded(1)
    expect(hardRight.right[0]).toBeGreaterThan(0)
    expect(hardRight.left[0], 'a hard right leaked into the left channel').toBe(0)

    // The same strike, mirrored: what moved is the channel, not the level, so
    // a channel merely muted somewhere would not produce this.
    expect(hardRight.right[0], 'the two edges are not one law').toBe(hardLeft.left[0])

    engine.engine_free(instance)
  })

  it('rewinds the transport when stopped across the wire', () => {
    // The effect nothing else here has, and the only thing that tells a stop
    // from a pattern that has gone quiet: the position goes back to zero.
    const { engine, instance, exchange } = withKit()
    const words = new Uint32Array(
      engine.memory.buffer,
      engine.engine_telemetry_ptr(instance),
      TELEMETRY_WORDS,
    )

    const count = write(
      exchange,
      { op: 'set-metronome', enabled: false },
      { op: 'set-bpm', bpm: 588 },
      { op: 'set-step', track: 3, step: 2, velocity: 0.5 },
      { op: 'play' },
    )
    render(engine, instance, 60, count)
    expect(words[TELEMETRY_TRANSPORT_LO], 'the transport never started').toBe(60 * QUANTUM)

    const stopped = write(exchange, { op: 'stop' })
    const after = render(engine, instance, 200, stopped).left

    expect(words[TELEMETRY_TRANSPORT_LO], 'the transport did not rewind').toBe(0)
    expect(strikes(after), 'the grid struck with the transport stopped').toEqual([])

    engine.engine_free(instance)
  })

  it('lays its telemetry block out where protocol.ts says it does', () => {
    // The half of the contract going the other way, and the one nothing used
    // to hold against the compiled engine. `PROTOCOL_VERSION` does cover this
    // block — its scope is everything crossing the ABI in either direction —
    // but the version only refuses a *mismatched* build, and a renumbering
    // shipped with both halves rebuilt is not a mismatch. Reorder two words in
    // engine.rs, mirror the reorder in telemetry-block.ts, and every other test
    // in this repository stays green while the page shows a position that is a
    // peak. This is the one that does not.
    const engine = instantiate()
    const instance = engine.engine_new(SAMPLE_RATE, QUANTUM)
    expect(instance).not.toBe(0)

    const exchange = new DataView(
      engine.memory.buffer,
      engine.engine_cmd_ptr(instance),
      engine.engine_cmd_capacity(instance) * COMMAND_SIZE,
    )
    const count = write(exchange, { op: 'set-bpm', bpm: 120 }, { op: 'play' })

    // The same bytes twice, exactly as the worklet and the page see them: the
    // block is copied word by word into the ring and the peaks are read back
    // through a float view over it.
    const telemetry = engine.engine_telemetry_ptr(instance)
    const words = new Uint32Array(engine.memory.buffer, telemetry, TELEMETRY_WORDS)
    const floats = new Float32Array(engine.memory.buffer, telemetry, TELEMETRY_WORDS)

    // Before the first block, so that everything below is a change this test
    // caused rather than whatever happened to be at that address.
    expect(Array.from(words), 'the block is not zeroed at construction').toEqual([
      0, 0, 0, 0, 0,
    ])

    render(engine, instance, 1, count)
    const struck = floats[TELEMETRY_PEAK_L]
    const firstStep = floats[TELEMETRY_STEP]

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

    // The grid's own position, and the one word here whose scale this side
    // cannot recompute: turning samples into steps takes the divisions per beat,
    // which is an engine constant and deliberately not mirrored — the page is
    // given the answer precisely so that it never needs the question. So what
    // is asserted is what crossing the wire can show: an `f32` inside the
    // pattern, moving with the transport, and not a copy of either neighbour.
    expect(firstStep).toBeGreaterThan(0)
    expect(firstStep).toBeLessThan(STEPS)
    expect(firstStep).not.toBe(struck)
    // The same reinterpretation check the peak gets: a step count in the bits
    // of an f32 is an enormous u32, and a word holding the number itself
    // would be a small one.
    expect(words[TELEMETRY_STEP], 'the step word is not f32 bits').toBeGreaterThan(1)

    const QUIET = 20
    render(engine, instance, QUIET, 0)

    expect(words[TELEMETRY_TRANSPORT_LO]).toBe((QUIET + 1) * QUANTUM)
    // Linear in the transport from zero, which pins the unit as far as this
    // side can: twenty-one blocks of it is twenty-one times one block of it.
    // A word carrying beats, or samples, or a step index would fail the
    // bounds above; one carrying a position that did not start at zero fails
    // here.
    expect(floats[TELEMETRY_STEP]).toBeCloseTo(firstStep * (QUIET + 1), 5)
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

/**
 * One frame per slot, and a different height in each.
 *
 * A one-frame sample turns the output into a direct reading: where a non-zero
 * frame sits is the onset, and how tall it is is everything that scaled it. The
 * heights are halving powers of two so that any two of them divide exactly —
 * which is what lets a strike say *which slot* it came from without any test
 * here naming a level. Levels belong to the mixer, and a test asserting one
 * would go red the next time the gain chain changes, over something that is not
 * its subject.
 */
const KIT = [1, 1 / 2, 1 / 4, 1 / 8, 1 / 16, 1 / 32, 1 / 64, 1 / 128]

/**
 * An instance with that kit in it, and the exchange area to command it through.
 *
 * The order is the rule this file now has to keep: **the kit goes in before any
 * view is built.** Reserving grows linear memory, growth detaches every view
 * over it, and a `DataView` on the exchange area is such a view — built first,
 * it would be dead by the time the first command was written into it, and the
 * engine would render on in silence.
 */
function withKit(): { engine: EngineExports; instance: number; exchange: DataView } {
  const engine = instantiate()
  const instance = engine.engine_new(SAMPLE_RATE, QUANTUM)
  expect(instance, 'engine_new refused arguments the worklet also passes').not.toBe(0)

  const arena = engine.engine_bank_reserve(instance, KIT.length)
  expect(arena, 'the engine would not give an arena for eight floats').not.toBe(0)
  new Float32Array(engine.memory.buffer, arena, KIT.length).set(KIT)

  KIT.forEach((_, slot) => {
    // Slot `n` at offset `n`: one frame, one channel, laid out end to end. Zero
    // is acceptance and the only thing this side reads — a refusal here is the
    // test's own bug and the number in it names which, in `lib.rs`.
    expect(
      engine.engine_sample_commit(instance, slot, slot, 1, 1),
      `the engine refused slot ${slot}`,
    ).toBe(0)
  })

  const exchange = new DataView(
    engine.memory.buffer,
    engine.engine_cmd_ptr(instance),
    engine.engine_cmd_capacity(instance) * COMMAND_SIZE,
  )
  return { engine, instance, exchange }
}

/**
 * Write commands into the exchange area and answer with the count to hand
 * `render`.
 *
 * The count comes back from the call that wrote them, so a command added to a
 * list cannot be left out of the number the engine is told to read — which
 * silently drops the last one and is invisible in a diff. Every record is
 * immediate: nothing here schedules ahead, and the first test that does will
 * want the instant as an argument rather than as this constant.
 */
function write(exchange: DataView, ...commands: Command[]): number {
  commands.forEach((command, index) => {
    writeCommand(exchange, index * COMMAND_SIZE, command, 0)
  })
  return commands.length
}

interface Rendered {
  readonly left: Float32Array
  readonly right: Float32Array
}

/** Render `quanta` blocks, passing the command count on the first one only. */
function render(
  engine: EngineExports,
  instance: number,
  quanta: number,
  cmdCount: number,
): Rendered {
  const left = new Float32Array(quanta * QUANTUM)
  const right = new Float32Array(quanta * QUANTUM)
  // Built per call rather than kept: a reservation between two renders replaces
  // the buffer these sit on, and a view held across one is a view that reads
  // nothing.
  const outL = new Float32Array(engine.memory.buffer, engine.engine_out_ptr(instance, 0), QUANTUM)
  const outR = new Float32Array(engine.memory.buffer, engine.engine_out_ptr(instance, 1), QUANTUM)

  for (let block = 0; block < quanta; block += 1) {
    engine.engine_process(instance, QUANTUM, block === 0 ? cmdCount : 0)
    left.set(outL, block * QUANTUM)
    right.set(outR, block * QUANTUM)
  }
  return { left, right }
}

/**
 * Where the non-zero frames are.
 *
 * Exact, and it can be: every sample in `KIT` is one frame long, so a strike is
 * a single non-zero value with silence on both sides of it. `clickOnsets`
 * exists beside this for the metronome, which is a decaying sine and needs the
 * block-by-block reading instead.
 */
function strikes(samples: Float32Array): number[] {
  const at: number[] = []
  samples.forEach((sample, frame) => {
    if (sample !== 0) at.push(frame)
  })
  return at
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
