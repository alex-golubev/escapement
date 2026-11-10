// What the load clock's thread, the worklet and the page share: no imports, as the worklet and the thread take it in.

/** How long each burst of the clock lasts, and how long it rests between, in milliseconds. */
export const burstMs = 100
export const restMs = 900

/** The words of the clock's memory: the time in µs, never 0, 0 at rest; whether the page measures; which burst. */
export const timeWord = 0
export const measuringWord = 1
export const burstWord = 2
/** How often the thread found itself put off between two readings: the time stood still meanwhile. */
export const gapsWord = 3

const words = 4

/** Read and written through Atomics alone: an Int32 can't tear, as a Float64 may. */
export const loadClockViews = (clock: SharedArrayBuffer) => new Int32Array(clock, 0, words)

export const createLoadClock = (): SharedArrayBuffer => new SharedArrayBuffer(words * 4)

/** Sets whether the clock's thread runs its bursts, waking it at once. */
export const measureLoad = (clock: SharedArrayBuffer, on: boolean) => {
  const clockWords = loadClockViews(clock)
  Atomics.store(clockWords, measuringWord, Number(on))
  Atomics.notify(clockWords, measuringWord)
}
