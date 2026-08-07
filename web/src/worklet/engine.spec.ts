// The failure paths of engine bring-up, which are the reason engine.ts exists
// as its own module. None can be produced by the real artifact — reaching them
// in a browser means deliberately breaking the wasm — so before this file they
// had never run. The happy path against the real module is in
// tests/engine-abi.spec.ts.

import { describe, expect, it } from 'vitest'

import { PROTOCOL_VERSION, TELEMETRY_WORDS } from '../audio/protocol'
import { describeInitError, openEngine, readModule } from './engine'
import type { EngineExports, EngineInitError } from './engine'
import { FAKE_LAYOUT, fakeEngine } from '../../tests/support/engine-fake'
import { unwrapError, unwrapValue } from '../../tests/support/unwrap'

const QUANTUM = FAKE_LAYOUT.quantum
/** Not 48000: nothing in this codebase may assume that rate. */
const SAMPLE_RATE = 44100

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

describe('openEngine', () => {
  it('refuses an engine whose protocol version is not the one this build encodes', () => {
    // The mismatch that matters: the wasm was rebuilt from a commands.rs the
    // TypeScript side has not caught up with, or the other way round.
    const engine = fakeEngine({ engine_protocol_version: () => PROTOCOL_VERSION + 1 })
    expect(unwrapError(openEngine(engine, SAMPLE_RATE, QUANTUM))).toEqual({
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
      unwrapError(openEngine(fakeEngine({ engine_new: () => 0 }), SAMPLE_RATE, QUANTUM)),
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
    expect(unwrapError(openEngine(broken, SAMPLE_RATE, QUANTUM)).kind).toBe('abi-unusable')
  })

  it('passes the arguments it was given straight through to the engine', () => {
    const seen: Array<[number, number]> = []
    const engine = fakeEngine({
      engine_new: (rate, frames) => {
        seen.push([rate, frames])
        return 1
      },
    })
    unwrapValue(openEngine(engine, SAMPLE_RATE, QUANTUM))
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
    expect(unwrapValue(openEngine(engine, SAMPLE_RATE, QUANTUM)).protocolVersion).toBe(
      PROTOCOL_VERSION,
    )
    expect(calls).toBe(1)
  })

  it('builds every view over the pointers the engine handed out', () => {
    const engine = fakeEngine()
    const { views } = unwrapValue(openEngine(engine, SAMPLE_RATE, QUANTUM))

    expect(views.outL.byteOffset).toBe(FAKE_LAYOUT.outL)
    expect(views.outR.byteOffset).toBe(FAKE_LAYOUT.outR)
    expect(views.outL).toHaveLength(QUANTUM)
    expect(views.outR).toHaveLength(QUANTUM)
    expect(views.telemetry.byteOffset).toBe(FAKE_LAYOUT.telemetry)
    expect(views.telemetry).toHaveLength(TELEMETRY_WORDS)

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
      'instantiation-failed': { kind: 'instantiation-failed', message: 'LinkError' },
      'abi-unusable': { kind: 'abi-unusable', message: 'not a function' },
      'protocol-mismatch': { kind: 'protocol-mismatch', engine: 2, expected: 1 },
      'engine-refused': { kind: 'engine-refused', sampleRate: 0, maxFrames: QUANTUM },
    }

    const messages = Object.values(samples).map(describeInitError)
    expect(messages.every((message) => message.length > 0)).toBe(true)
    expect(new Set(messages).size).toBe(messages.length)
  })
})
