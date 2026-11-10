import { burstMs, burstWord, gapsWord, loadClockViews, measuringWord, restMs, timeWord } from '../load-clock'

/** Longer between two readings, in ms, is the thread put off: performance.now() itself is far finer. */
const gapMs = 0.1

/** While the page measures, the time each tenth of a second, a core busy through it: the worklet has no clock. */
const run = (clock: SharedArrayBuffer) => {
  const words = loadClockViews(clock)
  // A thread stopped mid-burst may have left a time.
  Atomics.store(words, timeWord, 0)
  for (;;) {
    Atomics.wait(words, measuringWord, 0)
    Atomics.add(words, burstWord, 1)
    const until = performance.now() + burstMs
    for (let last = performance.now(), now = last; now < until; last = now, now = performance.now()) {
      Atomics.add(words, gapsWord, Number(now - last > gapMs))
      Atomics.store(words, timeWord, Math.round(now * 1000) | 0 || 1)
    }
    Atomics.store(words, timeWord, 0)
    // Sooner, should the page stop measuring meanwhile.
    Atomics.wait(words, measuringWord, 1, restMs)
  }
}

onmessage = ({ data }: MessageEvent<SharedArrayBuffer>) => run(data)
