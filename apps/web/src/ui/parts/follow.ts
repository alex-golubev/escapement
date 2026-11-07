import { ticksPerQuarter } from '@escapement/engine-description'
import { barTicks, stepTicks } from '@escapement/model'
import { Array, Option } from 'effect'
import { useMemo, useRef } from 'preact/hooks'

/**
 * The time along a window that scrolls across it, a pattern's or the arrangement's, in CSS pixels: how far it is
 * scrolled, how wide the part in sight is, and where a tick lies along it.
 */
export interface Lane {
  readonly left: number
  readonly width: number
  readonly xOf: (tick: number) => number
}

/** Whether the tick's column is in the part of the lane in sight. */
export const inSight = ({ left, width, xOf }: Lane, tick: number) => xOf(tick) >= left && xOf(tick) < left + width

/**
 * Whether the playhead has just come to be heard, or has left the lane in sight by itself: in sight a frame before, and
 * the window not scrolled by hand since, which would have taken it out.
 */
const comesOrLeaves = (lane: Lane, before: Option.Option<number>, now: number, scrolledByHand: boolean) =>
  Option.match(before, {
    onNone: () => true,
    onSome: (before) => !scrolledByHand && inSight(lane, before) && !inSight(lane, now)
  })

/** What the playhead's place is rounded down to as the window goes to it, the longest that keeps it in sight first. */
const followedBy = [barTicks, ticksPerQuarter, stepTicks, 1]

/** Scrolled to show the tick from the start of its bar; in a window too narrow for it, of its beat, its step, itself. */
const pageOf = (lane: Lane, tick: number) =>
  Option.map(
    Array.findFirst(
      followedBy.map((part) => Math.floor(tick / part) * part),
      (start) => inSight({ ...lane, left: lane.xOf(start) }, tick)
    ),
    lane.xOf
  )

/**
 * Where a window scrolls to as the playhead goes from the tick heard a frame before to the one heard now: to show it
 * from the start of its bar as it comes to be heard, and as it leaves the lane in sight by itself; not as the window is
 * scrolled away from it.
 */
export const followed = (
  lane: Lane,
  before: Option.Option<number>,
  now: number,
  scrolledByHand: boolean
): Option.Option<number> =>
  Option.flatMap(
    Option.liftPredicate(now, (now) => comesOrLeaves(lane, before, now, scrolledByHand)),
    (now) => pageOf(lane, now)
  )

/** A window following the playhead: told of its scrolls by hand, it says each frame where it scrolls to, if anywhere. */
export interface Follow {
  /** A scroll by hand, which `moved` the window across or not. */
  readonly scrolled: (moved: boolean) => void
  /**
   * Where to scroll to for the tick heard now, if anywhere, as the lane stands in sight: none behind a tab, where the
   * playhead comes back to be heard as the window does. Not while a button is held on it, which the jump would take a
   * step or a note from under.
   */
  readonly frame: (lane: Option.Option<Lane>, held: boolean, heard: Option.Option<number>) => Option.Option<number>
}

/** The playhead followed from frame to frame, as the piano roll and the Arrangement do. */
export const useFollow = (): Follow => {
  const heardBefore = useRef(Option.none<number>())
  const byHand = useRef(false)
  return useMemo(
    () => ({
      scrolled: (moved) => {
        byHand.current = byHand.current || moved
      },
      frame: (lane, held, heard) => {
        const left = Option.flatMap(
          Option.all({ now: Option.filter(lane, () => !held), tick: heard }),
          ({ now, tick }) => followed(now, heardBefore.current, tick, byHand.current)
        )
        heardBefore.current = Option.flatMap(lane, () => heard)
        byHand.current = false
        return left
      }
    }),
    []
  )
}
