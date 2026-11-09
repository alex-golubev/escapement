import { barTicks, type Id } from '@escapement/model'
import { Array, Number, Option, Order } from 'effect'
import type { Point } from '../../kit/pointer'
import type { Lane } from '../../parts/follow'
import type { Layout } from './layout'

/**
 * The arrangement as it stands in sight: its sizes, how far it is scrolled down from the first track's row, and how
 * far right from the first tick; and how many tracks it has, a row each from the top.
 */
export interface View extends Layout {
  readonly width: number
  readonly height: number
  readonly top: number
  readonly left: number
  readonly tracks: number
}

/** Where a clip stands: its track's place among the tracks, from 0, and its first tick. */
export interface Place {
  readonly place: number
  readonly tick: number
}

/** Where a clip stands, how long it is, in ticks from 1, and where in its pattern's rounds it starts. */
export interface Span extends Place {
  readonly length: number
  /** Ticks into its pattern's rounds, as the document has it: under 0 or past a round's length as it may be. */
  readonly offset: number
}

/** A clip as the arrangement draws it: where it stands, as long as it plays, and its pattern's length. */
export interface Drawn extends Span {
  /** Ticks, from 1: its pattern starts again every so many. */
  readonly period: number
}

/** A clip in the arrangement, to take hold of. */
export interface Shown extends Drawn {
  readonly id: Id
}

/** How wide so many ticks are. */
export const widthOf = ({ barWidth }: Layout, ticks: number) => (ticks / barTicks) * barWidth

/** The arrangement's time across its window, right of the heads, as the playhead goes along it. */
export const laneOf = (view: View): Lane => ({
  left: view.left,
  width: view.width - view.headsWidth,
  xOf: (ticks) => widthOf(view, ticks)
})

/** Where the tick is across the arrangement. */
export const xOf = (view: View, tick: number) => view.headsWidth + widthOf(view, tick) - view.left

/** Where the track's row starts down the arrangement. */
export const yOf = (view: View, place: number) => view.rulerHeight + place * view.trackHeight - view.top

/** The tick a column at `x` would be, were there ticks left of the arrangement's. */
export const tickUnder = (view: View, x: number) => ((x - view.headsWidth + view.left) / view.barWidth) * barTicks

/** The place of the track a row at `y` would be, were there tracks above and below the arrangement's. */
export const rowAt = (view: View, y: number) => Math.floor((y - view.rulerHeight + view.top) / view.trackHeight)

/**
 * As far as an arrangement this high with so many tracks scrolls down, in tracks: no further than the row under the
 * last one's, where + adds another.
 */
export const tracksDown = ({ trackHeight, rulerHeight }: Layout, height: number, tracks: number, down: number) =>
  Number.clamp(down, { minimum: 0, maximum: Math.max(tracks + 1 - (height - rulerHeight) / trackHeight, 0) })

/** As far as it scrolls across, in bars: until the end of the last clip, at `end`, stands at the tracks' heads. */
export const barsAcross = (end: number, across: number) => Number.clamp(across, { minimum: 0, maximum: end / barTicks })

/**
 * In the order drawn, the last on top: one that starts later over one before it, and of two that start together the
 * shorter over the longer, so a clip put inside another stays in reach; by ID where they are alike, the same everywhere.
 */
export const inDrawingOrder = (clips: ReadonlyArray<Shown>): ReadonlyArray<Shown> =>
  Array.sort(
    clips,
    Order.combine(
      Order.combine(
        Order.mapInput(Order.Number, ({ tick }: Shown) => tick),
        Order.mapInput(Order.flip(Order.Number), ({ length }: Shown) => length)
      ),
      Order.mapInput(Order.String, ({ id }: Shown) => id)
    )
  )

/** Where the last clip ends; the start without one. */
export const endOf = (clips: ReadonlyArray<Drawn>) =>
  clips.reduce((end, { tick, length }) => Math.max(end, tick + length), 0)

/** Whether the point is on the grid, right of the heads and under the ruler, on a track's row. */
const onGrid = (view: View, { x, y }: Point) =>
  x >= view.headsWidth && y >= view.rulerHeight && x < view.width && y < view.height && rowAt(view, y) < view.tracks

/** Of the clips under the point, the one drawn last, as it is on top; none off the grid, where none is seen. */
export const clipAt = (clips: ReadonlyArray<Shown>, view: View, point: Point): Option.Option<Shown> =>
  Option.flatMap(
    Option.liftPredicate(point, (point) => onGrid(view, point)),
    ({ x, y }) => {
      const place = rowAt(view, y)
      const tick = tickUnder(view, x)
      return Array.findLast(
        clips,
        (clip) => clip.place === place && tick >= clip.tick && tick < clip.tick + clip.length
      )
    }
  )

/** Where a double click at the point puts a clip: from the start of the bar it falls in, on the track's row. */
export const startAt = (view: View, point: Point): Option.Option<Place> =>
  Option.map(
    Option.liftPredicate(point, (point) => onGrid(view, point)),
    ({ x, y }) => ({
      place: rowAt(view, y),
      tick: Math.floor(tickUnder(view, x) / barTicks) * barTicks
    })
  )

/** The clips under the way from one point to the next, looked for a pixel apart, each once. */
export const clipsAlong = (clips: ReadonlyArray<Shown>, view: View, from: Point, to: Point): ReadonlyArray<Shown> => {
  const parts = Math.max(Math.ceil(Math.hypot(to.x - from.x, to.y - from.y)), 1)
  return Array.dedupeWith(
    Array.range(0, parts).flatMap((part) =>
      Option.toArray(
        clipAt(clips, view, {
          x: from.x + ((to.x - from.x) * part) / parts,
          y: from.y + ((to.y - from.y) * part) / parts
        })
      )
    ),
    (a, b) => a.id === b.id
  )
}

/** The whole numbers from `first` to `last`; none if `last` is before it, as nothing is in sight. */
export const wholesFrom = (first: number, last: number): ReadonlyArray<number> =>
  Array.range(first, last).filter((i) => i <= last)

/** The places of the tracks whose rows are at least partly in sight, first to last. */
export const tracksInSight = (view: View): ReadonlyArray<number> =>
  wholesFrom(
    Math.max(Math.floor(view.top / view.trackHeight), 0),
    Math.min(Math.ceil((view.top + view.height - view.rulerHeight) / view.trackHeight), view.tracks) - 1
  )

/** The bars at least partly in sight, by number from 0. */
export const barsInSight = (view: View): ReadonlyArray<number> =>
  wholesFrom(
    Math.floor(view.left / view.barWidth),
    Math.floor((view.left + view.width - view.headsWidth) / view.barWidth)
  )
