// The ring with both ends running at once, on two real threads.
//
// Everything else that covers the ring is single-threaded, and single-threaded
// is exactly what its two orderings are invisible to: the writer fills a record
// before it moves the write index, and the reader copies a run of records before
// it moves the read index. Swap either pair and every other suite stays green,
// because in one thread there is no moment between the two lines for anyone to
// look in.
//
// Here in `tests/` rather than beside a module because it covers three at once
// — `audio/ring-writer.ts`, `worklet/exchange.ts` and `audio/telemetry.ts` —
// and could not sit next to any one of them.
//
// **What this can and cannot catch.** It catches program order: a store moved to
// the wrong side of the bytes it publishes leaves a window as wide as the call
// it jumped over, and a hundred thousand records past a spinning reader land in
// it. It does not catch a compiler or a processor reordering two instructions
// that are already written in the right order — that is probabilistic, and no
// run of any length proves its absence. A green run here is evidence, not proof.
//
// The reason to believe it is evidence of anything is that it was checked by
// mutation, and the result is worth writing down because it divides the ring's
// guards in two. Three defects turn *this* red and nothing else: the write index
// published before the record's bytes, the read index advanced before the copy,
// and the seqlock's odd half dropped from `publishTelemetry`. Two more —
// `drainCommands` without its capacity clamp, and a seqlock carried on from an
// odd count — leave this green and are caught by the single-threaded suites that
// substitute those states directly, because neither state is reachable from a
// writer that works. Concurrency is what makes the first three observable and
// substitution is what makes the last two, and neither kind covers the other.
//
// **Why the run happens twice.** The third of those three needed a second shape
// to show up at all, and the first attempt at it did not: with the exchange area
// the engine actually reports, a read index advanced before the copy went
// undetected in ten runs out of ten. The reason is the distance behind a drain —
// the writer must cross `RING_CAPACITY - count` slots before it reaches what the
// reader is copying, and 768 of them is further than it gets in the time a copy
// takes. So the shapes below differ in exactly that: one drains a quantum's
// worth as fast as records arrive, the other waits for a full ring and takes all
// of it, leaving no distance behind the copy at all. The second is not a
// contrived configuration — `drainCommands` takes its limit from the destination
// by design, and a page-load pushing hundreds of parameters at once is the case
// that wants a larger exchange area.
//
// It runs under Node, not in a browser: a worker thread is not Chrome's
// real-time audio thread, and what is under test is the algorithm rather than
// the deployment.
//
// The worker is bundled here, from the same sources the app ships, and started
// from the bundle as a string. esbuild resolves and strips the TypeScript that
// Node's worker loader would not, and building it into a string keeps this from
// growing a third build artifact with a staleness problem of its own.

import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'

import { buildSync } from 'esbuild'
import { beforeAll, describe, expect, it } from 'vitest'

import { RING_CAPACITY, createRing, openRing } from '../src/audio/ring'
import { createWriter } from '../src/audio/ring-writer'
import { createReader } from '../src/audio/telemetry'
import type { Telemetry } from '../src/audio/telemetry'
import {
  PROGRESS_DRAINED,
  PROGRESS_RUNNING,
  PROGRESS_STOP,
  PROGRESS_WORDS,
  TELEMETRY_PROBES,
  probe,
} from './support/ring-harness'
import type { RingWorkerData, RingWorkerMessage } from './support/ring-harness'

/**
 * The run length §6.2 asks for. Long enough to lap the 1024-record ring some
 * ninety-eight times, which is what puts the two threads across a slot boundary
 * again and again rather than once.
 */
const COMMANDS = 100_000

/** What the engine reports through `engine_cmd_capacity`. */
const CMD_CAPACITY = 256

/**
 * How the audio thread takes its records. Both shapes assert the same things —
 * what differs is which ordering each one can see, and why is at the top of the
 * file.
 */
const SHAPES = [
  {
    name: 'draining a quantum at a time, as the engine reports its exchange area',
    capacity: CMD_CAPACITY,
    holdUntil: 0,
  },
  {
    name: 'draining a full ring at once, with no untouched slots behind the copy',
    capacity: RING_CAPACITY,
    holdUntil: RING_CAPACITY,
  },
] as const

/**
 * Generous by an order of magnitude — the run takes well under a second — and
 * present only so that a wedged run fails with something to read instead of
 * hanging until the suite is killed.
 */
const DEADLINE_MS = 30_000

interface Session {
  /** Commands `send` took. */
  readonly accepted: number
  /** Commands `send` refused because the ring was full. */
  readonly refused: number
  /** Calls to `send`, refusals included. */
  readonly attempts: number
  /** What the ring's own counter says, read once at the end. */
  readonly dropped: number
  /** Readings that matched one of the published probes exactly. */
  readonly published: number
  /** Frames where the writer was mid-publish every time the reader looked. */
  readonly nulls: number
  /** Readings matching no published probe — a torn read. Capped for legibility. */
  readonly torn: readonly string[]
  readonly tornCount: number
  /**
   * The record the page gave up on, having found the ring full with the worker
   * already stopped, or `null` if it sent all of them. Never the first thing to
   * assert: the worker stops because it found something, and what it found is a
   * better sentence than this is.
   */
  readonly stalledAt: number | null
  /** Which probes the page actually observed, by index. */
  readonly seenProbes: readonly boolean[]
  readonly report: Extract<RingWorkerMessage, { kind: 'report' }>
}

describe.each(SHAPES)('the ring with both ends running at once, $name', (shape) => {
  let session: Session

  // Twice the deadline the run holds itself to, so that a wedged run is cut
  // short by its own timer — which says how far the worker got — rather than by
  // vitest's, which says only that a hook took too long.
  beforeAll(async () => {
    session = await runSession(shape)
  }, DEADLINE_MS * 2)

  it('delivers every command it accepted, exactly once and in submission order', () => {
    // The worker compared each record against what `probe` should have written
    // at that position in the stream, so this one assertion carries three:
    // nothing arrived twice, nothing arrived out of turn, and nothing arrived
    // half-written.
    expect(session.report.mismatch).toBeNull()
    expect(
      session.stalledAt,
      'the worker stopped early without saying what it found',
    ).toBeNull()
    expect(session.report.drained).toBe(COMMANDS)
    expect(session.accepted).toBe(COMMANDS)
  })

  it('counts one drop for each command it refused, and no others', () => {
    // The counter's meaning under two threads, which is the only place it has
    // ever mattered: every `send` either put a record in the ring or added one
    // to this number, and never both or neither.
    expect(session.attempts).toBe(session.accepted + session.refused)
    expect(session.dropped).toBe(session.refused)
  })

  it('never hands the page a telemetry reading assembled from two quanta', () => {
    expect(session.torn).toEqual([])
    expect(session.tornCount).toBe(0)
  })

  it('read telemetry across both published states, so the check above had a moving target', () => {
    // Without this the assertion above passes on a run where the two threads
    // never overlapped — where the page read the same still block a hundred
    // thousand times and saw nothing to tear. The worker alternates states on
    // every quantum and runs thousands of them, so seeing one state and not the
    // other means the run did not observe concurrency at all, and a run that
    // proves nothing must fail rather than pass quietly.
    expect(session.published).toBeGreaterThan(0)
    expect(session.seenProbes).toEqual(TELEMETRY_PROBES.map(() => true))
  })
})

async function runSession(shape: (typeof SHAPES)[number]): Promise<Session> {
  const ring = createRing()
  const views = openRing(ring)
  const progress = new SharedArrayBuffer(PROGRESS_WORDS * Int32Array.BYTES_PER_ELEMENT)
  const progressWords = new Int32Array(progress)

  const data: RingWorkerData = {
    ring,
    progress,
    total: COMMANDS,
    capacity: shape.capacity,
    holdUntil: shape.holdUntil,
  }
  const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: data })

  const ready = deferred<void>()
  const report = deferred<Extract<RingWorkerMessage, { kind: 'report' }>>()
  worker.on('message', (message: RingWorkerMessage) => {
    if (message.kind === 'ready') ready.resolve()
    else report.resolve(message)
  })
  worker.on('error', (error: Error) => {
    ready.reject(error)
    report.reject(error)
  })

  try {
    await withDeadline(ready.promise, () => 'the worker never reported itself ready')

    const writer = createWriter(views)
    const reader = createReader(views)

    let accepted = 0
    let refused = 0
    let attempts = 0
    let published = 0
    let nulls = 0
    let tornCount = 0
    let stalledAt: number | null = null
    const torn: string[] = []
    const seenProbes = TELEMETRY_PROBES.map(() => false)

    for (let index = 0; index < COMMANDS; index += 1) {
      const command = probe(index)
      let sent = false
      while (!sent) {
        attempts += 1
        if (writer.send(command)) {
          sent = true
          accepted += 1
          break
        }
        refused += 1
        // The ring is full and only the worker can empty it, so a worker that
        // has already stopped means this spin has nothing left to wait for.
        //
        // Recorded and left, rather than thrown from here. The worker stops for
        // one interesting reason — it found a record that was not what it should
        // have been — and that diagnosis is in a report this thread has not
        // collected yet. Throwing here would replace "record 1025 was blank"
        // with "the ring was full", which is the symptom two steps downstream.
        if (Atomics.load(progressWords, PROGRESS_RUNNING) === 0) break
      }
      if (!sent) {
        stalledAt = index
        break
      }

      // Read on the same beat as the send, so the reads are spread across the
      // whole run rather than bunched at one end of it.
      const reading = reader.read()
      if (reading === null) {
        nulls += 1
        continue
      }
      const variant = TELEMETRY_PROBES.findIndex((state) => matches(state, reading))
      if (variant === -1) {
        tornCount += 1
        // Capped: a run that tore on every frame would otherwise build a
        // hundred thousand strings, and the first few say the same thing.
        if (torn.length < 8) {
          torn.push(`position ${reading.position}, peaks ${reading.peakL} / ${reading.peakR}`)
        }
      } else {
        published += 1
        seenProbes[variant] = true
      }
    }

    return {
      accepted,
      refused,
      attempts,
      dropped: writer.dropped(),
      published,
      nulls,
      torn,
      tornCount,
      stalledAt,
      seenProbes,
      report: await withDeadline(
        report.promise,
        () =>
          `the worker drained ${Atomics.load(progressWords, PROGRESS_DRAINED)} of ${COMMANDS} ` +
          `records in ${DEADLINE_MS} ms and then stopped reporting`,
      ),
    }
  } finally {
    // Stops a worker still spinning after a failure above, and then makes sure
    // of it: a live worker thread keeps the whole suite from exiting.
    Atomics.store(progressWords, PROGRESS_STOP, 1)
    await worker.terminate()
  }
}

function matches(state: (typeof TELEMETRY_PROBES)[number], reading: Telemetry): boolean {
  // All three fields together. A tear that took the position from one publish
  // and the peaks from the other leaves the position matching on its own.
  return (
    state.position === reading.position &&
    state.peakL === reading.peakL &&
    state.peakR === reading.peakR
  )
}

/**
 * The worker, bundled from `tests/support/ring-worker.ts` and held as source.
 *
 * Vite's pipeline reaches the specs but not a worker Node starts for itself, so
 * the TypeScript has to be resolved and stripped by something — and esbuild is
 * what already builds the worklet, from `web/node_modules`, which is where a
 * file in `web/` can import it from.
 *
 * Built once, at import, rather than per session: the two shapes differ in what
 * they pass the worker, not in the worker.
 */
const WORKER_SOURCE = buildWorker()

function buildWorker(): string {
  const built = buildSync({
    entryPoints: [fileURLToPath(new URL('./support/ring-worker.ts', import.meta.url))],
    bundle: true,
    // A string passed to `new Worker` with `eval` is evaluated as CommonJS.
    format: 'cjs',
    platform: 'node',
    write: false,
  })
  const output = built.outputFiles?.[0]
  if (output === undefined) throw new Error('esbuild produced no bundle for the ring worker')
  return output.text
}

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (reason: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/**
 * Fail with a sentence instead of hanging.
 *
 * The message is built when the deadline passes rather than beforehand, because
 * what is worth saying then is how far the other thread got — and a spinning
 * worker cannot be asked, which is what the progress words are for.
 */
async function withDeadline<T>(promise: Promise<T>, message: () => string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(message()))
        }, DEADLINE_MS)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
