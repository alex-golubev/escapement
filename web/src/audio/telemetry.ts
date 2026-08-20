// The page's end of the audio → UI direction: reading what the worklet
// published.
//
// The counterpart of `publishTelemetry`. The writer is on the audio thread and
// never waits; retrying is entirely this side's job, and it costs nothing here
// — a frame is 16 ms and the writer's critical section is a handful of stores.
//
// Two readers live here and they are read on different clocks — the snapshot on
// every frame, the frame counter once a second. That is not a reason to split
// the file: what it divides by is direction and the memory being described,
// like the three contracts it sits among, and which timer happens to call a
// reader is the caller's business. It matters only in one place, and the place
// says so: `renderDrift` is useless from `requestAnimationFrame`, because a
// hidden tab stops delivering frames long before it stops rendering audio.

import {
  WORD_PEAK_L,
  WORD_PEAK_R,
  WORD_RENDERED_FRAMES,
  WORD_STEP,
  WORD_TELEMETRY_SEQ,
  WORD_TRANSPORT_HI,
  WORD_TRANSPORT_LO,
} from './ring'
import type { RingViews } from './ring'

/** One coherent look at the engine: all of it from the same quantum. */
export interface Telemetry {
  /** Transport position in samples. A plain number, exact past any session. */
  readonly position: number
  /**
   * Peak level of the mix bus, per channel, with the engine's own ballistics
   * already applied.
   *
   * **Not bounded by 1.** It is read before the engine's limiter, which is
   * where the only useful reading is: the sum is deliberately hot, so a level
   * taken after the limiter sits against the ceiling and reports the same
   * number for a full pattern as for a third of one. Nothing is lost by
   * reading early — the limiter is a pure monotonic curve, so the level after
   * it follows from this one and not the other way round — but a reader that
   * assumes a 0…1 range will draw past its box.
   */
  readonly peakL: number
  readonly peakR: number
  /**
   * Where the sequencer stands within the pattern, in steps, wrapped into
   * `[0, STEPS)`. Fractional: the playhead is drawn at this position and the
   * cell to light is `Math.floor` of it.
   *
   * The page cannot work this out for itself, which is why it travels — turning
   * samples into a musical position takes the tempo anchor, and that lives in
   * the engine. A page counting from the BPM it last sent would be right until
   * the first tempo change.
   *
   * The floor can name the cell before or after the striking one by a fraction
   * of a sample, on a boundary and nowhere else; `sequencer::position_in_steps`
   * is where that is argued, and it is the only place it should be.
   */
  readonly step: number
}

export interface TelemetryReader {
  /**
   * The latest coherent reading, or `null` if the writer was mid-update every
   * time this looked. `null` is not an error: the caller keeps the previous
   * frame's values, and the next frame is 16 ms away.
   */
  read(): Telemetry | null
  /**
   * The free-running frame counter, as one plain word.
   *
   * No seqlock and no retry, unlike `read`: it is a single word, so there is
   * nothing to tear, and it is nobody's business to take it in the same breath
   * as the position. A method here rather than a function over the views,
   * because the views do not leave `host.ts` — what crosses is this reader, and
   * a second door to the same memory would be a second thing to hand every
   * caller.
   *
   * What the number means, and what it is worth pairing with, is argued at
   * `WORD_RENDERED_FRAMES`; turning two of these into a rate is `renderDrift`.
   */
  rendered(): number
}

/**
 * How many times to look before giving up for this frame.
 *
 * Not four chances at four moments: a handful of loads with nothing between
 * them take about as long as the handful of stores they are racing, so the
 * whole loop sits inside the window it is trying to outlast and this is nearer
 * one look than four. Widening it would not help either — waiting out a publish
 * means spinning the main thread on a value only the audio thread can change,
 * which is the one thing a reader here must never do.
 *
 * What makes that acceptable is the caller: a frame that reads nothing keeps
 * the numbers it already has, and the next frame is 16 ms and six publishes
 * later, holding a newer reading than any wait here could. The bound is not
 * tuned, and
 * there is nothing here to tune it against — it is a small number that is not
 * one, so that a reader arriving mid-store can still catch the same publish.
 */
const ATTEMPTS = 4

export function createReader(ring: RingViews): TelemetryReader {
  const { words, floats } = ring

  return {
    read(): Telemetry | null {
      for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
        const before = Atomics.load(words, WORD_TELEMETRY_SEQ)
        // Odd means a write is in progress, and the fields are a mix of two
        // quanta right now.
        if ((before & 1) === 1) continue

        // Plain reads, on purpose: the counter is what makes them safe, and
        // that is the whole shape of a seqlock. Making each field atomic would
        // not add anything the check below does not already give.
        const lo = words[WORD_TRANSPORT_LO]
        const hi = words[WORD_TRANSPORT_HI]
        const peakL = floats[WORD_PEAK_L]
        const peakR = floats[WORD_PEAK_R]
        const step = floats[WORD_STEP]

        // A write started and finished while the reads above were in flight.
        // Nothing above can be trusted — in particular `lo` and `hi` may now be
        // from either side of a quantum boundary.
        if (Atomics.load(words, WORD_TELEMETRY_SEQ) !== before) continue

        return { position: hi * 2 ** 32 + lo, peakL, peakR, step }
      }
      return null
    },

    rendered(): number {
      return Atomics.load(words, WORD_RENDERED_FRAMES)
    },
  }
}

/** Two readings of the counter, each with the wall-clock time it was taken at. */
export interface RenderSample {
  /** As `readRenderedFrames` returned it — unsigned, and free to have wrapped. */
  readonly frames: number
  /** `performance.now()`, in milliseconds. */
  readonly at: number
}

/**
 * How far the render thread fell behind the wall clock between two readings,
 * in milliseconds **per second** of wall clock. Positive is behind; a healthy
 * engine sits near zero.
 *
 * **A rate rather than the plain difference, and the caller's window is why.**
 * One reading of the counter is out by up to one of its steps — it advances in
 * whatever chunk the device asks the graph for, not frame by frame — and that
 * error is a fixed quantity of milliseconds no matter how long the window was.
 * Divided by the window it shrinks with it; kept as a total it does not, and
 * two windows of different lengths could not be held against one threshold at
 * all. How long a window to take is argued where it is chosen, at
 * `DRIFT_WINDOW`.
 *
 * **The subtraction is unsigned**, which is the one line here that is not
 * arithmetic anybody would write by accident. The counter laps every 2^32
 * frames, and a plain difference across that turns four billion into a negative
 * number — reported as the render thread having run *ahead* by a day, once,
 * some twenty-five hours into a session. `>>> 0` is what makes the interval
 * survive the lap, and it is the same reason the command indices are compared
 * that way.
 *
 * Answering `null` rather than a number for a window with no time in it: two
 * readings taken in the same millisecond describe nothing, and a zero returned
 * there would be indistinguishable from a healthy measurement. The caller has a
 * previous value to keep, exactly as it does for a refused telemetry read.
 *
 * Nothing here is a dropout detector. A quantum missed and made up inside one
 * window leaves this at zero, and it is meant to: what it sees is the thread
 * failing to keep up over seconds, which is the failure that ends a session
 * rather than the one that costs a click.
 */
export function renderDrift(
  before: RenderSample,
  after: RenderSample,
  sampleRate: number,
): number | null {
  const elapsedMs = after.at - before.at
  if (!(elapsedMs > 0) || !(sampleRate > 0)) return null

  const advanced = (after.frames - before.frames) >>> 0
  const lostMs = elapsedMs - (advanced / sampleRate) * 1000
  return lostMs / (elapsedMs / 1000)
}
