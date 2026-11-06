import type { Sha256 } from '@escapement/engine-description'
import type { Rejection } from './rejections'
import type { SamplePcm } from './samples'

export const processorName = 'escapement-engine'

/** Size prefix included; anything bigger goes to the build thread as a device edit. */
export const maxMessageBytes = 64 * 1024

export const blockFrames = 128

export const channelCount = 2

/** Meters the engine keeps for nodes beside the master's, numbered from 1; the board holds a record for each. */
export const meterCount = 500

/** Device edits for the build thread; its marker in the command ring carries the same number. */
export interface Batch {
  readonly _tag: 'Batch'
  readonly number: number
  /** A `DeviceBatch` table, in a buffer of its own so it can be transferred. */
  readonly bytes: Uint8Array
}

/** The page sends it to the build thread once, before it creates the processor; batches follow. */
export interface BuildThreadStart {
  readonly module: WebAssembly.Module
  /** Shared; the module imports it. */
  readonly memory: WebAssembly.Memory
  readonly sampleRate: number
  /** Built before the answer, so its parcel is there for the first block; only the tests' engine starts with one. */
  readonly initial?: Batch
}

/** A sound for the build thread to store, apart from batches: it has no order among them and no session. */
export interface StoreSample extends SamplePcm {
  readonly _tag: 'StoreSample'
  /** The page's, for the answer. */
  readonly id: number
  readonly hash: Sha256
}

/** The page no longer keeps the sound; there is no answer, since nothing can go wrong. */
export interface EvictSample {
  readonly _tag: 'EvictSample'
  readonly hash: Sha256
}

/** About sounds; the build thread takes them in the order sent. */
export type SampleMessage = StoreSample | EvictSample

/** Asks a thread whether it is there: it answers `Pong` as soon as it is free, which a hung one never is. */
export interface Ping {
  readonly _tag: 'Ping'
}

export interface Pong {
  readonly _tag: 'Pong'
}

/** What the page sends the build thread after its start. */
export type ToBuildThread = Batch | SampleMessage | Ping

/** The build thread's answer to its start; a failure reaches the page as the worker's `error` event. */
export interface BuildThreadReady {
  readonly _tag: 'Ready'
  /** The engine's address in the memory. */
  readonly engine: number
}

/** Each sound sent gets one. */
export type SampleAnswer =
  | { readonly _tag: 'SampleStored'; readonly id: number }
  | { readonly _tag: 'SampleRefused'; readonly id: number; readonly reason: Rejection }

export type FromBuildThread = BuildThreadReady | SampleAnswer | Pong

export interface EngineProcessorOptions {
  readonly module: WebAssembly.Module
  /** Shared; the module imports it. */
  readonly memory: WebAssembly.Memory
  /** Made by the build thread; the processor only plays it. */
  readonly engine: number
  /** The page writes, the processor reads. */
  readonly commandRing: SharedArrayBuffer
  /** The processor writes, the page reads. */
  readonly eventRing: SharedArrayBuffer
  /** The processor writes, the page reads. */
  readonly telemetryBoard: SharedArrayBuffer
}

/** The page is done with the engine: the processor renders no more, so the browser can let its node go. */
export interface StopProcessor {
  readonly _tag: 'Stop'
}

/** What the page sends the processor. */
export type ToProcessor = StopProcessor | Ping

/** Sent once by the processor at start. */
export interface WorkletInfo {
  hasPerformanceNow: boolean
}
