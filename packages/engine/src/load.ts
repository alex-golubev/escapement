import { Option } from 'effect'
import { loadClockViews, timeWord } from './load-clock'
import { blockFrames } from './protocol'
import type { Telemetry } from './telemetry'

/** A burst's load, of each block's time: the share taken on average and by the longest; and whether the sound broke. */
export interface DspLoad {
  readonly share: number
  readonly longest: number
  /** Since the burst before, as the browser counts it: never where it counts nothing. */
  readonly broke: boolean
}

/** Each burst's load once its clock rests, as the board tells it, with the browser's count of breaks since. */
export const dspLoadReader = (clock: SharedArrayBuffer, sampleRate: number) => {
  const words = loadClockViews(clock)
  const budget = (blockFrames / sampleRate) * 1_000_000
  const last = { burst: 0, underruns: Option.none<number>(), load: Option.none<DspLoad>() }
  return {
    read: (telemetry: Telemetry | undefined, underruns: number): Option.Option<DspLoad> => {
      // While the clock runs, the board counts the burst under way.
      Option.map(
        Option.filter(
          Option.fromUndefinedOr(telemetry),
          ({ load }) => Atomics.load(words, timeWord) === 0 && load.blocks > 0 && load.burst !== last.burst
        ),
        ({ load }) => {
          last.load = Option.some({
            share: load.busy / load.blocks / budget,
            longest: load.longest / budget,
            broke: Option.exists(last.underruns, (before) => underruns > before)
          })
          last.underruns = Option.some(underruns)
          last.burst = load.burst
        }
      )
      return last.load
    },
    /** Measuring stopped: what it measured is no longer news, nor are the breaks since. */
    forget: () => {
      last.load = Option.none()
      last.underruns = Option.none()
    }
  }
}
