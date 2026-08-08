// The page's end of the audio → UI direction: reading what the worklet
// published, from `requestAnimationFrame`.
//
// The counterpart of `publishTelemetry`. The writer is on the audio thread and
// never waits; retrying is entirely this side's job, and it costs nothing here
// — a frame is 16 ms and the writer's critical section is a handful of stores.

import {
  WORD_PEAK_L,
  WORD_PEAK_R,
  WORD_TELEMETRY_SEQ,
  WORD_TRANSPORT_HI,
  WORD_TRANSPORT_LO,
} from './ring'
import type { RingViews } from './ring'

/** One coherent look at the engine: all of it from the same quantum. */
export interface Telemetry {
  /** Transport position in samples. A plain number, exact past any session. */
  readonly position: number
  readonly peakL: number
  readonly peakR: number
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
 * The writer holds the counter odd for four stores. Against a quantum that
 * comes round every 2.7 ms that window is vanishing, so one retry is already
 * generous — but a bound there must be, because the alternative is a main
 * thread spinning on a value only another thread can change.
 */
const ATTEMPTS = 4

export function createReader(ring: RingViews): TelemetryReader {
  // `peaks` is the same bytes as `words`, read as what they are. Rust put them
  // there with `f32::to_bits`, and this is the reading that cannot disagree
  // with it — an f32 decoded by hand would be a second definition.
  const { words, peaks } = ring

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
        const peakL = peaks[WORD_PEAK_L]
        const peakR = peaks[WORD_PEAK_R]

        // A write started and finished while the four reads above were in
        // flight. Nothing above can be trusted — in particular `lo` and `hi`
        // may now be from either side of a quantum boundary.
        if (Atomics.load(words, WORD_TELEMETRY_SEQ) !== before) continue

        return { position: hi * 2 ** 32 + lo, peakL, peakR }
      }
      return null
    },
  }
}
