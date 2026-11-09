import { highestKey, lowestKey, MidiKey, Tick } from '@escapement/engine-description'
import { barTicks, defaultNote, type NewNote, type Note, stepTicks } from '@escapement/model'
import { Array, Boolean, Number, Option } from 'effect'
import type { Point } from '../../kit/pointer'
import type { Lane } from '../../parts/follow'
import type { Layout } from './layout'

const keyCount = highestKey - lowestKey + 1

/**
 * The roll as it stands in sight: its sizes, how far it is scrolled down from the highest key's row, and how far
 * right from the first tick.
 */
export interface View extends Layout {
  readonly width: number
  readonly height: number
  readonly top: number
  readonly left: number
}

/** As far as a roll this high scrolls down, in rows from the highest key's: no further than the lowest key's. */
export const rowsDown = ({ rowHeight, rulerHeight }: Layout, height: number, down: number) =>
  Math.min(Math.max(down, 0), Math.max(keyCount - (height - rulerHeight) / rowHeight, 0))

/** How wide so many ticks are on the grid. */
export const widthOf = ({ stepWidth }: Layout, ticks: number) => (ticks / stepTicks) * stepWidth

/** As far as a roll this wide scrolls across, in steps: no further than the end of the bar after the pattern's `end`. */
export const stepsAcross = ({ keysWidth, stepWidth }: Layout, width: number, end: number, across: number) =>
  Math.min(Math.max(across, 0), Math.max((end + barTicks) / stepTicks - (width - keysWidth) / stepWidth, 0))

/** Where the key's row starts down the roll. */
export const yOf = (view: View, key: number) => view.rulerHeight + (highestKey - key) * view.rowHeight - view.top

/** Where the tick is along the roll. */
export const xOf = (view: View, tick: number) => view.keysWidth + widthOf(view, tick) - view.left

/** The key a row at `y` would be, were there keys above and below the roll's. */
export const rowAt = (view: View, y: number) =>
  highestKey - Math.floor((y - view.rulerHeight + view.top) / view.rowHeight)

/** The tick a column at `x` would be, were there ticks left of the roll's. */
export const tickUnder = (view: View, x: number) => ((x - view.keysWidth + view.left) / view.stepWidth) * stepTicks

/** The key whose row is at `y`; none over the ruler. */
export const keyAt = (view: View, y: number): Option.Option<MidiKey> =>
  Option.liftPredicate(y, (y) => y >= view.rulerHeight).pipe(
    Option.map((y) => rowAt(view, y)),
    Option.filter((key) => key >= lowestKey && key <= highestKey),
    Option.map(MidiKey)
  )

/** Whether the key is a black one of the keyboard. */
export const isBlack = (key: number) => [1, 3, 6, 8, 10].includes(key % 12)

/** The key drawn at the point in the key's row: right of a black key, the white one above or below it, by its half. */
const drawnKeyAt = (view: View, { x, y }: Point, key: MidiKey): MidiKey =>
  Boolean.match(isBlack(key) && x >= view.blackKeyWidth, {
    onTrue: () =>
      MidiKey(key + Boolean.match(y < yOf(view, key) + view.rowHeight / 2, { onTrue: () => 1, onFalse: () => -1 })),
    onFalse: () => key
  })

/** The key drawn on the keyboard at the point; none right of it or over the ruler. */
export const keyboardKeyAt = (view: View, point: Point): Option.Option<MidiKey> =>
  Option.flatMap(
    Option.liftPredicate(point, ({ x }) => x < view.keysWidth),
    (point) => Option.map(keyAt(view, point.y), (key) => drawnKeyAt(view, point, key))
  )

/**
 * The key a press on the keyboard plays as the pointer goes: the one drawn under it, or past the keyboard the row's;
 * above or below the keys in sight, the last of them.
 */
export const keyPlayedAt = (view: View, point: Point): MidiKey => {
  const keys = keysInSight(view)
  const row = MidiKey(
    Number.clamp(rowAt(view, point.y), {
      minimum: Option.getOrElse(Array.last(keys), () => lowestKey),
      maximum: Option.getOrElse(Array.head(keys), () => highestKey)
    })
  )
  return Boolean.match(point.x < view.keysWidth, { onTrue: () => drawnKeyAt(view, point, row), onFalse: () => row })
}

/** The tick at `x`; none over the keyboard. */
export const tickAt = (view: View, x: number): Option.Option<number> =>
  Option.map(
    Option.liftPredicate(x, (x) => x >= view.keysWidth),
    (x) => tickUnder(view, x)
  )

/** Whether the point is on the roll: a drag holding the pointer goes on past it. */
const onRoll = (view: View, { x, y }: Point) => x < view.width && y < view.height

/** Of the notes under the point, the one drawn last, as it is on top; none past the roll, where none is seen. */
export const noteAt = (notes: ReadonlyArray<Note>, view: View, point: Point): Option.Option<Note> =>
  Option.flatMap(
    Option.all({
      key: keyAt(view, point.y),
      tick: tickAt(view, point.x),
      on: Option.liftPredicate(point, (point) => onRoll(view, point))
    }),
    ({ key, tick }) =>
      Array.findLast(notes, (note) => note.key === key && tick >= note.tick && tick < note.tick + note.length)
  )

/** Where a click at the point puts a note: from the start of the step it falls in, on the key's row. */
export const startAt = (view: View, point: Point): Option.Option<Pick<NewNote, 'tick' | 'key'>> =>
  Option.map(Option.all({ key: keyAt(view, point.y), tick: tickAt(view, point.x) }), ({ key, tick }) => ({
    tick: Tick(Math.floor(tick / stepTicks) * stepTicks),
    key
  }))

/** The notes under the way from one point to the next, looked for a pixel apart, each once. */
export const notesAlong = (notes: ReadonlyArray<Note>, view: View, from: Point, to: Point): ReadonlyArray<Note> => {
  const parts = Math.max(Math.ceil(Math.hypot(to.x - from.x, to.y - from.y)), 1)
  return Array.dedupeWith(
    Array.range(0, parts).flatMap((part) =>
      Option.toArray(
        noteAt(notes, view, {
          x: from.x + ((to.x - from.x) * part) / parts,
          y: from.y + ((to.y - from.y) * part) / parts
        })
      )
    ),
    (a, b) => a.id === b.id
  )
}

/** Scrolled down so the notes stand in the middle of a roll this high, or middle C without them; in rows. */
export const centredOn = (layout: Layout, notes: ReadonlyArray<Note>, height: number) => {
  const middle = Array.match(
    notes.map(({ key }) => key),
    {
      onEmpty: () => defaultNote.key,
      onNonEmpty: (keys) => (Math.min(...keys) + Math.max(...keys)) / 2
    }
  )
  return rowsDown(layout, height, highestKey - middle + 0.5 - (height - layout.rulerHeight) / 2 / layout.rowHeight)
}

/** The keys whose rows are at least partly in sight, highest first. */
export const keysInSight = (view: View): ReadonlyArray<number> => {
  const first = highestKey - Math.floor(view.top / view.rowHeight)
  const last = highestKey - (Math.ceil((view.top + view.height - view.rulerHeight) / view.rowHeight) - 1)
  return Array.range(Math.max(last, lowestKey), Math.min(first, highestKey)).toReversed()
}

/** The grid as the pattern's time across the roll: right of the keyboard, to the roll's right edge. */
export const laneOf = (view: View): Lane => ({
  left: view.left,
  width: view.width - view.keysWidth,
  xOf: (ticks) => widthOf(view, ticks)
})
