import { Number, Option } from 'effect'

/** Anything quieter reads as silence. */
const meterFloorDb = -60

/** A peak in decibels, the floor for anything quieter; 1 is full scale. */
const toDb = (peak: number) => Math.max(meterFloorDb, 20 * Math.log10(peak))

/** Where a peak stands on a meter drawn in decibels: 0 at the floor, 1 at full scale. */
export const meterPosition = (peak: number) =>
  Number.clamp((toDb(peak) - meterFloorDb) / -meterFloorDb, { minimum: 0, maximum: 1 })

/** One side's count of blocks over full scale, as one engine keeps it. */
export interface Overs {
  readonly engine: number
  readonly count: number
}

/** Whether the sound went over full scale between two looks at the board; a new engine counts afresh. */
export const wentOver = (before: Option.Option<Overs>, now: Option.Option<Overs>) =>
  Option.exists(
    Option.zipWith(before, now, (was, is) => was.engine === is.engine && was.count !== is.count),
    (over) => over
  )
