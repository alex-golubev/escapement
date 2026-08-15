// What the two ring suites push through the ring, and the checks that read it
// back out. Shared because the two are the same run at different scales:
// `exchange.spec.ts` drives a hundred thousand records through one thread, and
// `ring-concurrency.spec.ts` drives the same hundred thousand past a worker
// draining at that very moment. The second is only worth anything as a
// comparison against the first, and two probes that drifted apart would leave
// neither result meaning what it says.
//
// Nothing here imports from `node:`. The command probe is reached from a spec
// under `src/`, which is checked by the app project, and that project is not
// told about Node's types.

import type { Command } from '../../src/audio/protocol'
import { OP_SET_STEP } from '../../src/audio/protocol'
import { readRecord } from './abi'

/**
 * Where the sequence number lands in the record, besides the velocity: the
 * track is `index % 7` and the step `index % 13`, and the primes are the point.
 *
 * The stale record a broken reader picks up most easily is the one the slot
 * held on the previous lap — index `i - RING_CAPACITY`. The capacity is 1024,
 * so any field derived from `i` by a modulus sharing a factor with it comes out
 * *identical* on that record: `i % 8` and `i % 16`, the grid's own dimensions,
 * would both agree with a record a full lap old. 7 and 13 are coprime with 1024
 * and still inside the grid, so the previous lap disagrees in both.
 */
const TRACK_MODULUS = 7
const STEP_MODULUS = 13

/**
 * The record for sequence number `index`.
 *
 * `set-step` because it is the only command that addresses through both
 * `arg_a` and `arg_b`: the sequence number reaches three separate places in the
 * record — byte 1, bytes 2-3, bytes 4-7 — so a record torn between two writes
 * fails the check below even where the order of arrival alone would not notice.
 *
 * The velocity carries the number outright. It is an `f32` on the wire, exact
 * for integers to 2^24, which is 167 times the longest run either suite makes.
 *
 * What this cannot reach is bytes 8-15, the `at` field: the page's writer
 * stamps "immediately" into them and nothing it sends varies there. Covering
 * them would mean calling `writeCommand` directly, past `createWriter` — which
 * is a path the page does not take, and testing it here would be testing the
 * wrong thing to reach the right bytes.
 */
export function probe(index: number): Command {
  return {
    op: 'set-step',
    track: index % TRACK_MODULUS,
    step: index % STEP_MODULUS,
    velocity: index,
  }
}

/**
 * Read record `slot` out of a drained block and say how it differs from what
 * `probe(index)` would have written, or `null` if it does not differ.
 *
 * A string rather than a thrown assertion because one caller is a worker
 * thread, where `expect` does not exist and a failure has to survive a
 * `postMessage` to be seen at all.
 */
export function probeMismatch(block: DataView, slot: number, index: number): string | null {
  // Under the names `probe` gave them: what a `set-step` puts in `arg_a` is a
  // track, and the reading below is about the record's identity rather than
  // about where its fields sit.
  const { op, argA: track, argB: step, value: velocity } = readRecord(block, slot)

  if (op !== OP_SET_STEP) {
    return `record ${index}: opcode ${op}, expected ${OP_SET_STEP} — this slot was never written`
  }
  // Checked before the two address fields because it names the intruder: the
  // velocity is the sequence number itself, so a record from elsewhere says
  // outright which record it is. A slot read a lap early reports `index - 1024`.
  if (velocity !== index) {
    return `record ${index}: velocity ${velocity}, so this is record ${velocity} in record ${index}'s place`
  }
  if (track !== index % TRACK_MODULUS) {
    return `record ${index}: track ${track}, expected ${index % TRACK_MODULUS} — the record is torn across its first four bytes`
  }
  if (step !== index % STEP_MODULUS) {
    return `record ${index}: step ${step}, expected ${index % STEP_MODULUS} — the record is torn across its first four bytes`
  }
  return null
}

/**
 * One published state of the telemetry block, whole. Stated as the reading the
 * page must get back, because that is both what the worker publishes from and
 * what the run compares against — the words it lands in are the block builder's
 * business, and it splits a position the way the shipping code does.
 */
export interface TelemetryProbe {
  readonly position: number
  readonly peakL: number
  readonly peakR: number
}

/**
 * The two states the worklet side alternates between, quantum by quantum.
 *
 * Chosen so that **every publish moves both words of the position** — the first
 * lands as `(lo 0, hi 1)` and the second as `(lo 0xffffffff, hi 2)` — which
 * turns the crossing of 2^32 from something that happens once in a run into
 * something that happens on every single quantum. That is the whole exposure a
 * seqlock exists for: a reader that catches the low word of one publish beside
 * the high word of the other lands roughly 2^32 away from either.
 *
 * They are not plausible transport positions and are not meant to be — the
 * seqlock does not know what the number means, and a realistic position would
 * cross the boundary once in a hundred thousand records instead of every time.
 *
 * The peaks differ too, and are exact in `f32`, so the check covers the whole
 * block rather than the position alone: a reading is compared against these
 * three fields together, and all four ways of mixing the two probes produce a
 * combination that appears in neither.
 */
export const TELEMETRY_PROBES: readonly TelemetryProbe[] = [
  { position: 2 ** 32, peakL: 0.25, peakR: 0.75 },
  { position: 3 * 2 ** 32 - 1, peakL: 1.5, peakR: 0.5 },
]

/**
 * A side channel for the concurrency run, and test-only: the ring's own layout
 * says nothing about any of this and must not learn to.
 *
 * It exists because a spinning worker never returns to its event loop, so it
 * cannot answer a question over `postMessage` while it is stuck. Without this,
 * a run that wedges reports a bare timeout; with it, the failure says how far
 * the worker actually got.
 */
export const PROGRESS_WORDS = 3
/** How many records the worker has drained so far. Written by the worker. */
export const PROGRESS_DRAINED = 0
/** Set to 1 by the page to tell a spinning worker to give up. */
export const PROGRESS_STOP = 1
/**
 * 1 while the worker's loop runs, 0 once it has left it either way. The page
 * retries a refused `send` in a spin of its own, and this is what keeps that
 * spin from outliving the only thread that could ever end it.
 */
export const PROGRESS_RUNNING = 2

export interface RingWorkerData {
  readonly ring: SharedArrayBuffer
  readonly progress: SharedArrayBuffer
  /** How many records to drain before reporting back. */
  readonly total: number
  /** Records in the exchange area, standing in for `engine_cmd_capacity`. */
  readonly capacity: number
  /**
   * Records the worker waits for before it drains at all. `0` drains whatever
   * is there, which is a reader that never falls behind.
   *
   * It exists because of what sits *behind* a drain. The reader copies the run
   * of slots it took and only then releases them; a writer that reached those
   * slots mid-copy would overwrite records being read, and the distance it has
   * to cover first is `RING_CAPACITY - count`. With a quantum-sized exchange
   * area that distance is 768 records and no run of any length crosses it in
   * the time a copy takes — so a read index advanced too early stays invisible,
   * measured at nought out of ten. Waiting for a full ring and taking all of it
   * leaves no distance at all, and the same defect surfaces on every run.
   */
  readonly holdUntil: number
}

export type RingWorkerMessage =
  | { readonly kind: 'ready' }
  | {
      readonly kind: 'report'
      readonly drained: number
      readonly quanta: number
      readonly mismatch: string | null
    }
