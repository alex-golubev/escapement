// The page's end of the audio → UI direction: reading what the worklet
// published, from `requestAnimationFrame`.
//
// The counterpart of `publishTelemetry`. The writer is on the audio thread and
// never waits; retrying is entirely this side's job, and it costs nothing here
// — a frame is 16 ms and the writer's critical section is a handful of stores.

import {
  WORD_PEAK_L,
  WORD_PEAK_R,
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
  }
}
