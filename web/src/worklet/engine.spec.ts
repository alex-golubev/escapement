// The failure paths of engine bring-up, which are the reason engine.ts exists
// as its own module. None can be produced by the real artifact — reaching them
// in a browser means deliberately breaking the wasm — so before this file they
// had never run. The happy path against the real module is in
// tests/engine-abi.spec.ts.

import { describe, expect, it } from 'vitest'

import { COMMAND_SIZE, PROTOCOL_VERSION } from '../audio/protocol'
import {
  RING_BYTES,
  WORD_PROTOCOL_VERSION,
  createRing,
  headerWords,
  openRing,
} from '../audio/ring'
import { describeInitError, openEngine, readModule, readRing } from './engine'
import type { EngineExports, EngineInitError } from './engine'
import { TELEMETRY_WORDS } from './telemetry-block'
import { FAKE_LAYOUT, fakeEngine } from '../../tests/support/engine-fake'
import { unwrapError, unwrapValue } from '../../tests/support/unwrap'

const QUANTUM = FAKE_LAYOUT.quantum
/** Not 48000: nothing in this codebase may assume that rate. */
const SAMPLE_RATE = 44100

/** The real thing: `SharedArrayBuffer` needs no browser, only Node. */
const ring = () => openRing(createRing())

/** The eight bytes of a valid, empty WebAssembly module. */
const EMPTY_MODULE = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])

describe('readModule', () => {
  it('refuses an option bag that never carried a module', () => {
    expect(unwrapError(readModule(undefined)).kind).toBe('no-module')
    expect(unwrapError(readModule({})).kind).toBe('no-module')
  })

  it('refuses a value that is not a module, and says what arrived instead', () => {
    // The bag crosses a thread boundary through structured clone, so its
    // contents are input, not a promise the type system can keep. Naming the
    // type that arrived is what turns this from "it broke" into a fix.
    const error = unwrapError(readModule({ module: 42 }))
    expect(error).toEqual({ kind: 'no-module', received: 'number' })
    expect(unwrapError(readModule({ module: null }))).toEqual({
      kind: 'no-module',
      received: 'null',
    })
  })

  it('accepts a real module', () => {
    const module = new WebAssembly.Module(EMPTY_MODULE)
    expect(unwrapValue(readModule({ module }))).toBe(module)
  })
})

describe('readRing', () => {
  it('refuses an option bag that never carried a ring', () => {
    expect(unwrapError(readRing(undefined))).toEqual({ kind: 'no-ring', received: 'undefined' })
    expect(unwrapError(readRing({ ring: null }))).toEqual({ kind: 'no-ring', received: 'null' })
  })

  it('refuses a buffer that is not shared', () => {
    // An ArrayBuffer would cross by copy, and every command written into it
    // would land in memory the audio thread never sees. The page would look
    // like it was working and the engine would hear nothing.
    expect(unwrapError(readRing({ ring: new ArrayBuffer(RING_BYTES) })).kind).toBe('no-ring')
  })

  it('refuses a ring shorter than this build reads', () => {
    const short = new SharedArrayBuffer(RING_BYTES - 4)
    expect(unwrapError(readRing({ ring: short }))).toEqual({
      kind: 'ring-too-small',
      bytes: RING_BYTES - 4,
      needed: RING_BYTES,
    })
  })

  it('refuses a ring stamped by a page that speaks another version', () => {
    // The everyday version of this is not a protocol change at all: the
    // worklet bundle is built by its own script, outside Vite's module graph,
    // and one left unrebuilt is a stale program with a live page in front of
    // it. The symptom without this check is silence.
    const stale = createRing()
    // Through `Atomics`, the way `createRing` stamps it: this stands in for a
    // page, so it should write the way a page writes.
    Atomics.store(headerWords(stale), WORD_PROTOCOL_VERSION, PROTOCOL_VERSION + 1)

    expect(unwrapError(readRing({ ring: stale }))).toEqual({
      kind: 'ring-version-mismatch',
      ring: PROTOCOL_VERSION + 1,
      worklet: PROTOCOL_VERSION,
    })
  })

  it('accepts the ring the page builds', () => {
    const built = createRing()
    expect(unwrapValue(readRing({ ring: built }))).toBe(built)
  })
})

describe('openEngine', () => {
  it('refuses an engine whose protocol version is not the one this build encodes', () => {
    // The mismatch that matters: the wasm was rebuilt from a commands.rs the
    // TypeScript side has not caught up with, or the other way round.
    const engine = fakeEngine({ engine_protocol_version: () => PROTOCOL_VERSION + 1 })
    expect(unwrapError(openEngine(engine, ring(), SAMPLE_RATE, QUANTUM))).toEqual({
      kind: 'protocol-mismatch',
      engine: PROTOCOL_VERSION + 1,
      expected: PROTOCOL_VERSION,
    })
  })

  it('treats a zero handle as a refusal rather than rendering through it', () => {
    // A null instance reaching `engine_process` is a wild pointer on the audio
    // thread. Checked here and nowhere later, so this test is the only thing
    // standing behind that "nowhere later".
    expect(
      unwrapError(
        openEngine(fakeEngine({ engine_new: () => 0 }), ring(), SAMPLE_RATE, QUANTUM),
      ),
    ).toEqual({ kind: 'engine-refused', sampleRate: SAMPLE_RATE, maxFrames: QUANTUM })
  })

  it('stays describable when the ABI cannot be called at all', () => {
    // What a module built with a lost #[unsafe(no_mangle)] looks like from
    // here: the export is simply absent, and calling it throws TypeError.
    // build-wasm.sh guards the surface, but it skips that check when node is
    // missing, so the throw has to arrive as a value like everything else.
    const broken = fakeEngine({
      engine_new: undefined as unknown as EngineExports['engine_new'],
    })
    expect(unwrapError(openEngine(broken, ring(), SAMPLE_RATE, QUANTUM)).kind).toBe(
      'abi-unusable',
    )
  })

  it('stays describable when the export that is missing is a pointer', () => {
    // The same lost #[unsafe(no_mangle)], on one of the five functions called
    // while the views are built rather than one of the three called before.
    // Those five used to sit outside the catch, so this threw out of the
    // processor constructor instead — and a throw there reaches the page as a
    // `processorerror` carrying no reason, which is the one outcome every
    // failure in this file is shaped to avoid.
    for (const absent of [
      'engine_out_ptr',
      'engine_cmd_ptr',
      'engine_telemetry_ptr',
    ] as const) {
      const broken = fakeEngine({ [absent]: undefined })
      expect(
        unwrapError(openEngine(broken, ring(), SAMPLE_RATE, QUANTUM)).kind,
        `${absent} threw instead of being reported`,
      ).toBe('abi-unusable')
    }
  })

  it('stays describable when a pointer does not fit the memory behind it', () => {
    // An engine that answers every call and answers wrong. The view
    // constructor is what notices, with a RangeError — nothing else here ever
    // compares a pointer against the size of linear memory, and nothing should:
    // one check at the boundary is what the exchange area is for.
    const broken = fakeEngine({ engine_telemetry_ptr: () => 65_530 })
    expect(unwrapError(openEngine(broken, ring(), SAMPLE_RATE, QUANTUM)).kind).toBe(
      'abi-unusable',
    )
  })

  it('passes the arguments it was given straight through to the engine', () => {
    const seen: Array<[number, number]> = []
    const engine = fakeEngine({
      engine_new: (rate, frames) => {
        seen.push([rate, frames])
        return 1
      },
    })
    unwrapValue(openEngine(engine, ring(), SAMPLE_RATE, QUANTUM))
    expect(seen).toEqual([[SAMPLE_RATE, QUANTUM]])
  })

  it('records the version it read instead of asking the engine twice', () => {
    // The `ready` message carries this number to the page. Reading it once
    // keeps the value the check was made against and the value reported from
    // being two different calls.
    let calls = 0
    const engine = fakeEngine({
      engine_protocol_version: () => {
        calls += 1
        return PROTOCOL_VERSION
      },
    })
    expect(unwrapValue(openEngine(engine, ring(), SAMPLE_RATE, QUANTUM)).protocolVersion).toBe(
      PROTOCOL_VERSION,
    )
    expect(calls).toBe(1)
  })

  it('builds every view over the pointers the engine handed out', () => {
    const engine = fakeEngine()
    const { views } = unwrapValue(openEngine(engine, ring(), SAMPLE_RATE, QUANTUM))

    expect(views.outL.byteOffset).toBe(FAKE_LAYOUT.outL)
    expect(views.outR.byteOffset).toBe(FAKE_LAYOUT.outR)
    expect(views.outL).toHaveLength(QUANTUM)
    expect(views.outR).toHaveLength(QUANTUM)
    expect(views.telemetry.byteOffset).toBe(FAKE_LAYOUT.telemetry)
    expect(views.telemetry).toHaveLength(TELEMETRY_WORDS)

    // Sized from `engine_cmd_capacity`, because that view's length is what
    // caps a quantum's worth of commands. Too long is a copy past the end of
    // the exchange area; too short silently throttles the command path.
    expect(views.cmd.byteOffset).toBe(engine.engine_cmd_ptr(1))
    expect(views.cmd).toHaveLength(engine.engine_cmd_capacity(1) * COMMAND_SIZE)

    // Kept so `process()` can spot a detach by reference. If this stopped
    // being the buffer the views were built over, the comparison would fire
    // every quantum and rebuild forever.
    expect(views.buffer).toBe(engine.memory.buffer)
  })
})

describe('describeInitError', () => {
  it('has a distinct, non-empty message for every failure that exists', () => {
    // Keyed by the union, so adding a case to EngineInitError fails to compile
    // here until it is given a sample — and `describeInitError` has no default
    // branch, so it fails to compile too. Both ends of the switch are pinned.
    const samples: Record<EngineInitError['kind'], EngineInitError> = {
      'no-module': { kind: 'no-module', received: 'undefined' },
      'no-ring': { kind: 'no-ring', received: 'undefined' },
      'ring-too-small': { kind: 'ring-too-small', bytes: 64, needed: RING_BYTES },
      'ring-version-mismatch': { kind: 'ring-version-mismatch', ring: 2, worklet: 1 },
      'instantiation-failed': { kind: 'instantiation-failed', message: 'LinkError' },
      'abi-unusable': { kind: 'abi-unusable', message: 'not a function' },
      'protocol-mismatch': { kind: 'protocol-mismatch', engine: 2, expected: 1 },
      'engine-refused': { kind: 'engine-refused', sampleRate: 0, maxFrames: QUANTUM },
    }

    const messages = Object.values(samples).map(describeInitError)
    expect(messages.every((message) => message.length > 0)).toBe(true)
    expect(new Set(messages).size).toBe(messages.length)
  })

  it('never continues a sentence after text that came from elsewhere', () => {
    // The rule `describeStartFailure` states on the page side, held here too:
    // these two carry the text of a caught throw, which ends with a full stop
    // of its own as often as not. Ours running on after it produced a visible
    // `..` on screen once already.
    const thrown = 'WebAssembly.Instance(): Import #0 not found.'

    for (const error of [
      { kind: 'instantiation-failed', message: thrown },
      { kind: 'abi-unusable', message: thrown },
    ] as const) {
      const message = describeInitError(error)
      expect(message, `${error.kind} runs on after the thrown text`).not.toContain('..')
      expect(message.endsWith(thrown), `${error.kind} buries it mid-sentence`).toBe(true)
    }
  })
})
