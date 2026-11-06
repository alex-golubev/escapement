// The only place that creates engine instances, and the only one that knows about stacks and thread-local data.
// One module runs on two threads over one shared memory, and each needs its own of both.

import { panicTextTaker, withPanicText } from './panic-text'

export interface EngineExports {
  engine_schema_fingerprint(): number
  engine_plugins_fingerprint(): number
  engine_block_frames(): number
  engine_channels(): number
  engine_max_message(): number
  engine_telemetry_words(): number
  engine_meters(): number
  engine_ticks_per_quarter(): number
  engine_min_tempo(): number
  engine_max_tempo(): number
  engine_default_tempo(): number
  engine_highest_key(): number
  engine_min_velocity(): number
  engine_max_velocity(): number
  /** Returns the build thread's part. */
  engine_new(sampleRate: number): number
  /** Once: the audio thread's part; 0 after. */
  engine_hand_over(build: number): number
  /** Room for a batch, valid until the next call. */
  engine_batch_bytes(build: number, length: number): number
  engine_build(build: number, batch: number): void
  /** Frees the parcels that came back; returns how many aren't back yet. */
  engine_collect(build: number): number
  /** Room for the SHA-256 of the next sound to store or evict. */
  engine_sample_hash(build: number): number
  /** Returns how many numbers to copy, 0 once the sound is in; or, below 0, −1 − the `Rejection` it got. */
  engine_sample_begin(build: number, sampleRate: number, channels: number, frames: number): number
  /** Room for the next `count` numbers, valid until the next call. */
  engine_sample_place(build: number, count: number): number
  /** Answers as `engine_sample_begin`. */
  engine_sample_copied(build: number, count: number): number
  /** Never while a sound is coming in. */
  engine_sample_evict(build: number): void
  engine_input_capacity(): number
  engine_input(engine: number): number
  engine_input_len(engine: number): number
  engine_process(engine: number, frames: number, received: number, eventRoom: number): number
  engine_output(engine: number, channel: number): number
  engine_event_capacity(): number
  engine_events(engine: number): number
  engine_telemetry(engine: number): number
  /** This thread's: see `panicTextTaker`. */
  engine_panic_text(): number
  engine_panic_text_bytes(): number
}

/** From the linker, exported for the thread start, and from `wasm-opt --stack-check`. */
interface ThreadExports {
  readonly __stack_pointer: WebAssembly.Global
  /** The first thread's stack, which the linker lays out. */
  readonly __stack_low: WebAssembly.Global
  readonly __stack_high: WebAssembly.Global
  readonly __tls_base: WebAssembly.Global
  readonly __tls_size: WebAssembly.Global
  readonly __tls_align: WebAssembly.Global
  __wasm_init_tls(tls: number): void
  /** This instance's bounds; any move of its stack pointer past them traps. */
  __set_stack_limits(top: number, bottom: number): void
  /** The address of the audio thread's place. */
  readonly ENGINE_AUDIO_THREAD: WebAssembly.Global
}

export type EngineInstance = EngineExports & ThreadExports

/** Every export above by kind; the compiler keeps the two lists the same. */
const exportKinds = {
  engine_schema_fingerprint: 'function',
  engine_plugins_fingerprint: 'function',
  engine_block_frames: 'function',
  engine_channels: 'function',
  engine_max_message: 'function',
  engine_telemetry_words: 'function',
  engine_meters: 'function',
  engine_ticks_per_quarter: 'function',
  engine_min_tempo: 'function',
  engine_max_tempo: 'function',
  engine_default_tempo: 'function',
  engine_highest_key: 'function',
  engine_min_velocity: 'function',
  engine_max_velocity: 'function',
  engine_new: 'function',
  engine_hand_over: 'function',
  engine_batch_bytes: 'function',
  engine_build: 'function',
  engine_collect: 'function',
  engine_sample_hash: 'function',
  engine_sample_begin: 'function',
  engine_sample_place: 'function',
  engine_sample_copied: 'function',
  engine_sample_evict: 'function',
  engine_input_capacity: 'function',
  engine_input: 'function',
  engine_input_len: 'function',
  engine_process: 'function',
  engine_output: 'function',
  engine_event_capacity: 'function',
  engine_events: 'function',
  engine_telemetry: 'function',
  engine_panic_text: 'function',
  engine_panic_text_bytes: 'function',
  __stack_pointer: 'global',
  __stack_low: 'global',
  __stack_high: 'global',
  __tls_base: 'global',
  __tls_size: 'global',
  __tls_align: 'global',
  __wasm_init_tls: 'function',
  __set_stack_limits: 'function',
  ENGINE_AUDIO_THREAD: 'global'
} as const satisfies Record<keyof EngineInstance, WebAssembly.ImportExportKind>

/** Throws unless the module runs in the memory it is given and has every export, so a stale build fails here. */
export const checkModule = (module: WebAssembly.Module) => {
  const imports = WebAssembly.Module.imports(module).some(
    ({ module: namespace, name, kind }) => namespace === 'env' && name === 'memory' && kind === 'memory'
  )
  const exports = new Map(WebAssembly.Module.exports(module).map(({ name, kind }) => [name, kind]))
  // Views over a memory of its own would read nothing.
  if (!imports || [...exports.values()].includes('memory')) {
    throw new Error('The engine does not run in the shared memory the page gives it; rebuild it')
  }
  const missing = Object.entries(exportKinds).filter(([name, kind]) => exports.get(name) !== kind)
  if (missing.length > 0) {
    throw new Error(`The engine lacks ${missing.map(([name, kind]) => `${kind} ${name}`).join(', ')}; rebuild it`)
  }
}

const instantiate = (module: WebAssembly.Module, memory: WebAssembly.Memory) => {
  checkModule(module)
  return new WebAssembly.Instance(module, { env: { memory } }).exports as unknown as EngineInstance
}

/**
 * Every call throws a trap with what the panic said, if the thread panicked. Not for the audio thread: each call would
 * allocate its arguments.
 */
const withPanicTexts = (instance: EngineInstance, memory: WebAssembly.Memory): EngineInstance => {
  const panicText = panicTextTaker(memory, instance.engine_panic_text() >>> 0)
  const calls = Object.entries(exportKinds)
    .filter(([, kind]) => kind === 'function')
    .map(([name]) => {
      const call = instance[name as keyof EngineInstance] as (...args: ReadonlyArray<number>) => unknown
      const explained = (...args: ReadonlyArray<number>) => {
        try {
          return call(...args)
        } catch (error) {
          throw withPanicText(error, panicText)
        }
      }
      return [name, explained] as const
    })
  return { ...instance, ...Object.fromEntries(calls) }
}

/**
 * First on a memory: the linker's start code lays the memory out and gives this thread its stack and thread-local
 * data. A later instance waits while that runs, and the audio thread may not wait.
 */
export const startBuildThread = (module: WebAssembly.Module, memory: WebAssembly.Memory): EngineInstance => {
  const instance = instantiate(module, memory)
  // The start code set it only if the memory was new; otherwise this thread's data would sit at address 0.
  if (instance.__tls_base.value === 0) {
    throw new Error('The build thread must be the first instance on its memory')
  }
  instance.__set_stack_limits(instance.__stack_high.value, instance.__stack_low.value)
  return withPanicTexts(instance, memory)
}

/** The audio thread's stack and thread-local data, reserved in the module. */
export interface AudioThreadPlace {
  readonly stackTop: number
  readonly stackBottom: number
  readonly tls: number
  readonly tlsCapacity: number
}

/** Read from memory, calling nothing. */
export const audioThreadPlace = (instance: EngineInstance, memory: WebAssembly.Memory): AudioThreadPlace => {
  const [stackTop, stackBottom, tls, tlsCapacity] = new Uint32Array(
    memory.buffer,
    instance.ENGINE_AUDIO_THREAD.value,
    4
  )
  return { stackTop, stackBottom, tls, tlsCapacity }
}

/** Throws unless the module's thread-local data fits the reserved block. */
export const checkTls = ({ tls, tlsCapacity }: AudioThreadPlace, size: number, align: number) => {
  if (size > tlsCapacity || tls % align !== 0) {
    throw new Error(
      `The engine's thread-local data (${size} bytes, aligned to ${align}) does not fit ${tlsCapacity} bytes at ${tls}`
    )
  }
}

/**
 * After the build thread's. Takes its place before any call into the engine: until then it would run on the build
 * thread's stack, with its thread-local data at address 0.
 */
export const startAudioThread = (module: WebAssembly.Module, memory: WebAssembly.Memory): EngineInstance => {
  const instance = instantiate(module, memory)
  const place = audioThreadPlace(instance, memory)
  checkTls(place, instance.__tls_size.value, instance.__tls_align.value)
  instance.__set_stack_limits(place.stackTop, place.stackBottom)
  instance.__stack_pointer.value = place.stackTop
  instance.__wasm_init_tls(place.tls)
  return instance
}
