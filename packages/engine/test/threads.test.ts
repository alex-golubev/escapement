import { Option, Result } from 'effect'
import { expect, test } from 'vitest'
import { Command } from '../src/commands'
import { DeviceEdit } from '../src/device-edits'
import { createEngineMemory, memoryPages } from '../src/memory'
import { panicTextBytes, panicTextTaker } from '../src/panic-text'
import { audioThreadPlace, checkModule, checkTls, startAudioThread, startBuildThread } from '../src/threads'
import { live, module, startEngine } from './harness'

// Headers of modules with a memory of their own: none at all, and one exported as `memory`.
const moduleHeader = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]
const ownMemory = [
  0x05,
  0x03,
  0x01,
  0x00,
  0x01,
  0x07,
  0x0a,
  0x01,
  0x06,
  ...new TextEncoder().encode('memory'),
  0x02,
  0x00
]

test('an engine that does not run in the memory it is given is refused at start', () => {
  const modules = [moduleHeader, [...moduleHeader, ...ownMemory]]
  modules.forEach((bytes) => {
    const other = new WebAssembly.Module(new Uint8Array(bytes))
    expect(() => startBuildThread(other, createEngineMemory())).toThrow(/shared memory/)
    expect(() => startAudioThread(other, createEngineMemory())).toThrow(/shared memory/)
  })
})

test('a module without every export the page relies on is refused at start', () => {
  // Imports a shared memory, as the engine does, and exports nothing.
  const memoryImport = [0x02, 0x10, 0x01, 0x03, ...new TextEncoder().encode('env'), 0x06]
  const bytes = [...moduleHeader, ...memoryImport, ...new TextEncoder().encode('memory'), 0x02, 0x03, 0x01, 0x01]
  const other = new WebAssembly.Module(new Uint8Array(bytes))
  expect(() => checkModule(other)).toThrow(
    /lacks function engine_schema_fingerprint, .*global ENGINE_AUDIO_THREAD; rebuild/
  )
  expect(() => checkModule(module)).not.toThrow()
})

test('a memory the engine was not linked for is refused at start', () => {
  // With the page's own size passing everywhere else, this pins it to the linked size exactly.
  const smaller = new WebAssembly.Memory({ ...memoryPages, initial: memoryPages.initial - 1, shared: true })
  const unshared = new WebAssembly.Memory(memoryPages)
  const memories = [smaller, unshared]
  memories.forEach((memory) => expect(() => startBuildThread(module, memory)).toThrow(WebAssembly.LinkError))
})

test('the audio thread runs on the stack and thread-local data reserved for it, apart from the build thread', () => {
  const memory = createEngineMemory()
  const build = startBuildThread(module, memory)
  const audio = startAudioThread(module, memory)
  const place = audioThreadPlace(audio, memory)
  expect([audio.__stack_pointer.value, audio.__tls_base.value]).toEqual([place.stackTop, place.tls])
  // The linker's start code gave the build thread its own: a later instance gets none.
  expect(build.__stack_pointer.value).not.toBe(place.stackTop)
  expect([0, place.tls]).not.toContain(build.__tls_base.value)
})

test('a second build thread on a memory is refused', () => {
  const memory = createEngineMemory()
  startBuildThread(module, memory)
  expect(() => startBuildThread(module, memory)).toThrow(/first instance on its memory/)
})

/** What `call` threw. */
const thrown = (call: () => unknown) =>
  Option.getOrThrowWith(Result.getFailure(Result.try(call)), () => new Error('Nothing was thrown'))

test('a panic of either thread throws what it said, the trap its cause; each thread has a text of its own', () => {
  const engine = startEngine()
  engine.send(live(Command.PanicAudio({ code: 4 })))
  const audio = thrown(() => engine.peak())
  expect(audio).toBeInstanceOf(Error)
  expect(audio).toMatchObject({
    message: expect.stringMatching(/^panicked at crates\/engine-core\/src\/engine\.rs:\d+:\d+: PanicAudio 4$/),
    cause: expect.any(WebAssembly.RuntimeError)
  })
  const build = thrown(() => engine.send({ edits: [DeviceEdit.PanicBuild({ code: 5 })] }))
  expect(build).toMatchObject({
    message: expect.stringMatching(/^panicked at crates\/engine-core\/src\/build\.rs:\d+:\d+: PanicBuild 5$/),
    cause: expect.any(WebAssembly.RuntimeError)
  })
  expect(engine.audioThread.engine_panic_text()).not.toBe(engine.buildThread.engine_panic_text())
})

test('a panic text is taken once, and a length past its room is no text', () => {
  const memory = new WebAssembly.Memory({ initial: 1 })
  const take = panicTextTaker(memory, 64)
  expect(take()).toBeUndefined()
  new Uint32Array(memory.buffer, 64, 1)[0] = 2
  new Uint8Array(memory.buffer, 68, 2).set([104, 105])
  expect([take(), take()]).toEqual(['hi', undefined])
  new Uint32Array(memory.buffer, 64, 1)[0] = panicTextBytes + 1
  expect(take()).toBeUndefined()
})

// Not a panic: the trap is thrown as it is.
test('going past the stack of either thread traps instead of overwriting what lies beyond', () => {
  const memory = createEngineMemory()
  const build = startBuildThread(module, memory)
  const audio = startAudioThread(module, memory)
  // A few bytes above the bottom; making an engine needs more.
  build.__stack_pointer.value = build.__stack_low.value + 16
  expect(() => build.engine_new(48_000)).toThrow(WebAssembly.RuntimeError)
  audio.__stack_pointer.value = audioThreadPlace(audio, memory).stackBottom + 16
  expect(() => audio.engine_new(48_000)).toThrow(WebAssembly.RuntimeError)
})

test('each thread counts its own heap calls', () => {
  const engine = startEngine()
  engine.buildThread.engine_new(48_000)
  engine.peak()
  expect(engine.readTelemetry()?.heapCalls).toBe(0)
  engine.audioThread.engine_new(48_000)
  engine.peak()
  expect(engine.readTelemetry()?.heapCalls).toBeGreaterThan(0)
})

test('thread-local data that outgrew its reserved block is refused', () => {
  const place = { stackTop: 8192, stackBottom: 4096, tls: 1024, tlsCapacity: 256 }
  expect(() => checkTls(place, 256, 16)).not.toThrow()
  expect(() => checkTls(place, 257, 16)).toThrow(/does not fit 256 bytes at 1024/)
  expect(() => checkTls({ ...place, tls: 1028 }, 16, 16)).toThrow(/aligned to 16/)
})
