import type { Sha256 } from '@escapement/engine-description'
import {
  defaultTempo,
  descriptionsFingerprint,
  highestKey,
  maxTempo,
  maxVelocity,
  minTempo,
  minVelocity,
  ticksPerQuarter
} from '@escapement/engine-description/contract'
import { sha256Bytes } from '../hash-bytes'
import { type Batch, type BuildThreadStart, blockFrames, channelCount, maxMessageBytes, meterCount } from '../protocol'
import { rejectionOf } from '../rejections'
import { schemaFingerprint } from '../schema/fingerprint'
import { panicTextBytes } from '../panic-text'
import { engineTelemetryWords } from '../telemetry'
import { type EngineExports, type EngineInstance, startBuildThread } from '../threads'
import type { Progress, SamplePool } from './sample-queue'

/** Throws unless the engine was built for the same contract as the page. */
export const checkContract = (wasm: EngineExports) => {
  const words = {
    engine_schema_fingerprint: schemaFingerprint,
    engine_plugins_fingerprint: descriptionsFingerprint,
    engine_block_frames: blockFrames,
    engine_channels: channelCount,
    engine_max_message: maxMessageBytes,
    engine_telemetry_words: engineTelemetryWords,
    engine_meters: meterCount,
    engine_panic_text_bytes: panicTextBytes,
    engine_ticks_per_quarter: ticksPerQuarter,
    engine_min_tempo: minTempo,
    engine_max_tempo: maxTempo,
    engine_default_tempo: defaultTempo,
    engine_highest_key: highestKey
  } as const
  const floats = { engine_min_velocity: minVelocity, engine_max_velocity: maxVelocity } as const
  const checks = [
    // A `u32` reaches JavaScript as a signed number.
    ...Object.entries(words).map(([name, value]) => [name, wasm[name as keyof typeof words]() >>> 0, value] as const),
    // An `f32` as the double nearest it.
    ...Object.entries(floats).map(
      ([name, value]) => [name, wasm[name as keyof typeof floats](), Math.fround(value)] as const
    )
  ]
  for (const [name, actual, value] of checks) {
    if (actual !== value) {
      // Fingerprints as the generated code writes them.
      const show = (number: number) => (name.endsWith('_fingerprint') ? `0x${number.toString(16)}` : String(number))
      throw new Error(
        `The engine's ${name}() is ${show(actual)}, this page expects ${show(value)}: they come from different ` +
          'builds. Run `pnpm gen` if the schema or a plugin changed, then rebuild the engine.'
      )
    }
  }
}

export interface BatchBuilder {
  /** Makes a parcel of the batch for the audio thread; returns how many parcels aren't back yet. */
  readonly build: (batch: Batch) => number
  /** Frees the parcels that came back; returns how many aren't back yet. */
  readonly collect: () => number
}

const batchBuilder = (wasm: EngineExports, memory: WebAssembly.Memory, build: number): BatchBuilder => ({
  build: ({ number, bytes }) => {
    const at = wasm.engine_batch_bytes(build, bytes.length) >>> 0
    // A view of the memory as it is after the call, which may have grown it.
    new Uint8Array(memory.buffer, at, bytes.length).set(bytes)
    wasm.engine_build(build, number)
    return wasm.engine_collect(build)
  },
  collect: () => wasm.engine_collect(build)
})

/** A negative answer is −1 − the `Rejection`. */
const progressOf = (answer: number): Progress => (answer < 0 ? rejectionOf(-1 - answer) : answer)

// Each view is of the memory as it is after the call before, which may have grown it.
const samplePool = (wasm: EngineExports, memory: WebAssembly.Memory, build: number): SamplePool => {
  const writeHash = (hash: Sha256) =>
    new Uint8Array(memory.buffer, wasm.engine_sample_hash(build) >>> 0, 32).set(sha256Bytes(hash))
  return {
    begin: (hash, sampleRate, channels, frames) => {
      writeHash(hash)
      return progressOf(wasm.engine_sample_begin(build, sampleRate, channels, frames))
    },
    copy: (numbers) => {
      new Float32Array(memory.buffer, wasm.engine_sample_place(build, numbers.length) >>> 0, numbers.length).set(
        numbers
      )
      return progressOf(wasm.engine_sample_copied(build, numbers.length))
    },
    evict: (hash) => {
      writeHash(hash)
      wasm.engine_sample_evict(build)
    }
  }
}

/**
 * The build thread's start. Returns its instance too, the only one it may have (see `startBuildThread`), and the
 * engine's address for the audio thread.
 */
export const buildEngine = ({ module, memory, sampleRate, initial }: BuildThreadStart) => {
  const wasm: EngineInstance = startBuildThread(module, memory)
  checkContract(wasm)
  // Addresses come back as signed numbers.
  const build = wasm.engine_new(sampleRate) >>> 0
  const engine = wasm.engine_hand_over(build) >>> 0
  const builder = batchBuilder(wasm, memory, build)
  if (initial !== undefined) builder.build(initial)
  return { wasm, engine, builder, samples: samplePool(wasm, memory, build) }
}
