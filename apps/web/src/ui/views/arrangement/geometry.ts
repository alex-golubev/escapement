import { barTicks, type Id, type Note, startInRound } from '@escapement/model'
import { Array, Boolean, Number, Option, Order } from 'effect'
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

/** A clip in the arrangement, to take hold of, and the pattern its preview shows. */
export interface Shown extends Drawn {
  readonly id: Id
  readonly pattern: Id
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

/** Of the clips under the point, the one drawn last; none off the grid. A clip holds its row's whole height, inset or not. */
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

/** A pattern's notes as a clip's preview draws them, and the lowest and highest keys among them. */
export interface Preview {
  readonly notes: ReadonlyArray<Pick<Note, 'tick' | 'length' | 'key'>>
  readonly low: number
  readonly high: number
}

/** None for a pattern without notes, whose preview stays empty. */
export const previewOf = (notes: ReadonlyArray<Note>): Option.Option<Preview> =>
  Array.match(notes, {
    onEmpty: () => Option.none(),
    onNonEmpty: (some) => {
      const keys = some.map(({ key }) => key)
      return Option.some({
        notes: some.map(({ tick, length, key }) => ({ tick, length, key })),
        low: Math.min(...keys),
        high: Math.max(...keys)
      })
    }
  })

/** A note's thickness in a preview `height` high: a key's share of it, down to a pixel, `most` at most. */
export const noteHeightOf = ({ low, high }: Preview, height: number, most: number) =>
  Number.clamp(Math.floor(height / (high - low + 1)), { minimum: 1, maximum: most })

/** How far down a preview `height` high a note of the key stands: the highest at the top, one key alone midway. */
export const noteTop = ({ low, high }: Preview, key: number, height: number, noteHeight: number) =>
  Boolean.match(high === low, {
    onTrue: () => (height - noteHeight) / 2,
    onFalse: () => ((high - key) / (high - low)) * (height - noteHeight)
  })

/** A note as the clip plays it: from its start to its end in the arrangement's ticks, and its key. */
export interface NotePlayed {
  readonly start: number
  readonly end: number
  readonly key: number
}

/** The preview's notes as the clip plays them round its pattern, cut to it, of the rounds over `from`–`to` only. */
export const notesPlayed = (
  { tick, length, period, offset }: Drawn,
  { notes }: Preview,
  from: number,
  to: number
): ReadonlyArray<NotePlayed> => {
  const [start, end] = [Math.max(tick, from), Math.min(tick + length, to)]
  // Where the round the clip starts in starts, at or before the clip.
  const rounds = tick - startInRound(offset, period)
  return wholesFrom(Math.floor((start - rounds) / period), Math.floor((end - 1 - rounds) / period)).flatMap((round) =>
    notes.flatMap((note) => {
      const played = rounds + round * period + note.tick
      return Option.toArray(
        Option.liftPredicate(
          { start: Math.max(played, tick), end: Math.min(played + note.length, tick + length), key: note.key },
          (cut) => cut.start < cut.end && cut.end > start && cut.start < end
        )
      )
    })
  )
}
