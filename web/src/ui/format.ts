// Turning the engine's numbers into something to read.
//
// Out of the components for the reason `paint.ts` is: a `.svelte` file is code
// no test in this package runs, and what lives here is arithmetic, which is
// where the mistakes are. The one below was found by moving it.

/**
 * The transport position as a clock — minutes, then seconds to the millisecond.
 *
 * Worked out from the sample count and the rate the context reported, never
 * accumulated: a counter kept here beside the engine's would be a second answer
 * to the same question, and the two would part company somewhere past the tenth
 * minute — which is the whole reason the engine counts in whole samples.
 *
 * **The rounding happens once, on the whole span, and that is not tidiness.**
 * Split first and rounded after — `(total - minutes * 60).toFixed(3)`, which is
 * how this was written — a span of 59.9996 s floors to minute 0 and rounds to
 * `60.000`, so the clock reads `0:60.000` for the half-millisecond before every
 * minute. It looks like a clock, it is wrong, and it is wrong for a window too
 * short to catch by watching. Rounded to whole milliseconds first, there is
 * nothing left for the split to disagree with.
 */
export function formatClock(samples: number, rate: number | null): string {
  // Nothing to say rather than a wrong thing: the rate arrives from a context
  // that has opened, so before one has there is no answer, and zero would
  // divide into an infinity that formats without complaint.
  if (rate === null || rate <= 0) return '—'

  const total = Math.round((samples / rate) * 1000)
  const minutes = Math.floor(total / 60_000)
  const seconds = (total - minutes * 60_000) / 1000

  // Padded so the digits stay in their columns while the number moves under
  // them; six characters is `00.000`.
  return `${minutes}:${seconds.toFixed(3).padStart(6, '0')}`
}
