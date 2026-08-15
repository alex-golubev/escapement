// The audio thread's end of the ring, on a real second thread.
//
// This is the worklet's per-quantum sequence and nothing more: drain what the
// page queued, then publish telemetry. Both come from the shipping modules —
// the moment this file reimplements either of them it stops testing the ring
// and starts testing a copy of it, which is the one outcome that would make a
// green run worse than no run at all.
//
// Bundled and started by tests/ring-concurrency.spec.ts, which runs it twice
// with different `capacity` and `holdUntil` — the two shapes are argued there.
//
// It spins rather than sleeping, in either shape. Contention is the entire
// point: a worker that yields is a worker whose reads never land inside the
// page's writes, and every ordering defect this exists to catch would pass.
// `holdUntil` is not a yield — it is a spin that watches the backlog instead of
// the ring, so that a drain takes a run of slots rather than the one or two a
// reader that never falls behind ever finds.

import { parentPort, workerData } from 'node:worker_threads'

import { COMMAND_SIZE } from '../../src/audio/protocol'
import { WORD_CMD_READ, WORD_CMD_WRITE, openRing } from '../../src/audio/ring'
import { drainCommands, publishTelemetry } from '../../src/worklet/exchange'
import { telemetryBlock, writeTelemetryBlock } from './abi'
import {
  PROGRESS_DRAINED,
  PROGRESS_RUNNING,
  PROGRESS_STOP,
  TELEMETRY_PROBES,
  probeMismatch,
} from './ring-harness'
import type { RingWorkerData, RingWorkerMessage } from './ring-harness'

if (parentPort === null) throw new Error('ring-worker.ts only runs as a worker thread')
const port = parentPort

const { ring, progress, total, capacity, holdUntil } = workerData as RingWorkerData

const views = openRing(ring)
// Stands in for the view over `engine_cmd_ptr`, at the size the real engine
// reports through `engine_cmd_capacity`.
const destination = new Uint8Array(capacity * COMMAND_SIZE)
const drained = new DataView(destination.buffer)
const progressWords = new Int32Array(progress)

// The block the engine would have filled in. Made once and refilled, because
// this thread runs thousands of quanta and its job is to crowd the ring rather
// than the collector.
const telemetry = telemetryBlock()

function publish(quantum: number): void {
  writeTelemetryBlock(telemetry, TELEMETRY_PROBES[quantum % TELEMETRY_PROBES.length])
  publishTelemetry(views, telemetry)
}

/** Records the page has queued and this thread has not taken yet. */
function queued(): number {
  return (
    (Atomics.load(views.words, WORD_CMD_WRITE) - Atomics.load(views.words, WORD_CMD_READ)) >>> 0
  )
}

let seen = 0
let quantum = 0
let mismatch: string | null = null

Atomics.store(progressWords, PROGRESS_RUNNING, 1)
try {
  // One publish before the page is told to start, so that every reading it
  // takes afterwards is a published one. Without it the opening frames read a
  // ring of zeroes — a coherent reading of nothing, which the page would have
  // to be taught to accept, and that exemption is exactly the hole a broken
  // reader would sit in.
  publish(quantum)
  port.postMessage({ kind: 'ready' } satisfies RingWorkerMessage)

  while (seen < total && Atomics.load(progressWords, PROGRESS_STOP) === 0) {
    // Let the backlog reach `holdUntil` before taking any of it — capped by
    // what is left to send, or the last partial round would wait for records
    // the page has already run out of. Telemetry keeps going out meanwhile,
    // which is what the real worklet does too: a quantum publishes whether or
    // not a command arrived in it.
    const want = Math.min(holdUntil, total - seen)
    while (queued() < want && Atomics.load(progressWords, PROGRESS_STOP) === 0) {
      quantum += 1
      publish(quantum)
    }

    const count = drainCommands(views, destination)

    // Checked here rather than shipped home for the page to check: a hundred
    // thousand records over `postMessage` is a copy of the whole run, and all
    // the page needs is the first record that was not what it should have been.
    for (let slot = 0; slot < count && mismatch === null; slot += 1) {
      mismatch = probeMismatch(drained, slot, seen + slot)
    }
    if (mismatch !== null) break

    seen += count
    Atomics.store(progressWords, PROGRESS_DRAINED, seen)

    quantum += 1
    publish(quantum)
  }
} finally {
  // Before the report, and in a `finally` because the page spins on a full ring
  // waiting for this thread to make room. A worker that died holding this at 1
  // would leave the page spinning for the rest of the run.
  Atomics.store(progressWords, PROGRESS_RUNNING, 0)
}

port.postMessage({
  kind: 'report',
  drained: seen,
  quanta: quantum,
  mismatch,
} satisfies RingWorkerMessage)
