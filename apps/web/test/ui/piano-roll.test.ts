import { lastTick, MidiKey, Tick, ticksPerQuarter } from '@escapement/engine-description'
import { barTicks, Id, type Note, stepTicks } from '@escapement/model'
import { Option } from 'effect'
import { expect, test } from 'vitest'
import { followed } from '../../src/ui/parts/follow'
import { cursorAt, draggedNotes, draggedTo, grabAt } from '../../src/ui/windows/piano-roll/drag'
import {
  centredOn,
  keyAt,
  keysInSight,
  laneOf,
  noteAt,
  notesAlong,
  scrolledAcross,
  scrolledTo,
  startAt,
  tickAt,
  type View,
  widthOf,
  xOf,
  yOf
} from '../../src/ui/windows/piano-roll/geometry'
import { edgeWidth } from '../../src/ui/kit/edge'
import { keysWidth, rowHeight, rulerHeight, stepWidth } from '../../src/ui/windows/piano-roll/layout'
import { keyName } from '../../src/ui/windows/piano-roll/draw'

/**
 * A bar wide, scrolled so C4's row is the first under the ruler, and C#2's the last: the rows of C#4 and up are above.
 */
const view: View = { width: 560, height: rulerHeight + 24 * rowHeight, top: (127 - 72) * rowHeight, left: 0 }

/** A bar on the grid, in pixels. */
const barWidth = widthOf(barTicks)

const note = (id: string, tick: number, key: number, length: number): Note => ({
  id: Id(id),
  tick: Tick(tick),
  key: MidiKey(key),
  length,
  velocity: 1
})

/** The middle of the key's row at the tick. */
const at = (tick: number, key: number) => ({ x: xOf(view, tick), y: yOf(view, key) + rowHeight / 2 })

test("keys are named as most DAWs name them, middle C C3, and a row is a key's down from the highest", () => {
  expect([0, 60, 61, 71, 127].map(keyName)).toEqual(['C-2', 'C3', 'C#3', 'B3', 'G8'])
  expect(keyAt(view, rulerHeight)).toEqual(Option.some(72))
  expect(keyAt(view, rulerHeight + rowHeight - 0.5)).toEqual(Option.some(72))
  expect(keyAt(view, rulerHeight + rowHeight)).toEqual(Option.some(71))
  expect(keyAt(view, rulerHeight - 1)).toEqual(Option.none())
  // Past the lowest key's row, scrolled as far down as the roll goes.
  const bottom = { ...view, top: scrolledTo(view.height, Number.POSITIVE_INFINITY) }
  expect(keyAt(bottom, view.height - 1)).toEqual(Option.some(0))
  expect(keyAt(bottom, view.height + rowHeight)).toEqual(Option.none())
})

test("a tick is a step across a column, past the pattern's end too; none over the keyboard", () => {
  expect(tickAt(view, keysWidth)).toEqual(Option.some(0))
  expect(tickAt(view, keysWidth + stepWidth * 1.5)).toEqual(Option.some(stepTicks * 1.5))
  expect(tickAt(view, xOf(view, barTicks * 3))).toEqual(Option.some(barTicks * 3))
  expect(tickAt(view, keysWidth - 1)).toEqual(Option.none())
})

/** Scrolled across two bars and a step. */
const across: View = { ...view, left: widthOf(2 * barTicks + stepTicks) }

/** The middle of the key's row at the tick, as the roll scrolled across shows it. */
const acrossAt = (tick: number, key: number) => ({ x: xOf(across, tick), y: at(tick, key).y })

test('scrolled across, the grid starts later: a click there puts a note later, and a note there is found', () => {
  expect(xOf(across, 2 * barTicks + stepTicks)).toBe(keysWidth)
  expect(tickAt(across, keysWidth)).toEqual(Option.some(2 * barTicks + stepTicks))
  expect(tickAt(across, keysWidth - 1)).toEqual(Option.none())
  expect(startAt(across, { x: keysWidth + stepWidth * 2.5, y: at(0, 64).y })).toEqual(
    Option.some({ tick: 2 * barTicks + 3 * stepTicks, key: 64 })
  )
  const later = note('a', 2 * barTicks + 4 * stepTicks, 64, 2 * stepTicks)
  expect(noteAt([later], across, acrossAt(2 * barTicks + 4.5 * stepTicks, 64))).toEqual(Option.some(later))
  // Scrolled out of sight under the keyboard, and left of the grid: none.
  const early = note('b', 0, 64, 2 * barTicks + 2 * stepTicks)
  expect(noteAt([early], across, { x: keysWidth - 1, y: at(0, 64).y })).toEqual(Option.none())
  expect(cursorAt([later], across, acrossAt(2 * barTicks + 6 * stepTicks - 1, 64))).toBe('stretch')
  expect(cursorAt([later], across, acrossAt(2 * barTicks + 5 * stepTicks, 64))).toBe('move')
})

test("the roll scrolls across from the first bar to the end of the bar after the pattern's end, none if it is wider", () => {
  expect(scrolledAcross(keysWidth + barWidth, barTicks, -5)).toBe(0)
  expect(scrolledAcross(keysWidth + barWidth, barTicks, 10 ** 6)).toBe(barWidth)
  expect(scrolledAcross(keysWidth + barWidth, 4 * barTicks, 10 ** 6)).toBe(4 * barWidth)
  expect(scrolledAcross(keysWidth + barWidth, 4 * barTicks, 100)).toBe(100)
  expect(scrolledAcross(keysWidth + 3 * barWidth, 2 * barTicks, 10 ** 6)).toBe(0)
  expect(scrolledAcross(keysWidth + 8 * barWidth, 2 * barTicks, 10 ** 6)).toBe(0)
})

test('the playhead takes the roll to its bar as it starts to be heard and as it leaves the grid, not as the roll leaves it', () => {
  const barsIn = (bars: number) => bars * barTicks
  // Starting to be heard, wherever the roll is: to the start of the bar heard, scrolled by hand just then too.
  expect(followed(laneOf(view), Option.none(), barsIn(2.5), false)).toEqual(Option.some(2 * barWidth))
  expect(followed(laneOf(across), Option.none(), 0, true)).toEqual(Option.some(0))
  // In sight, on and on.
  expect(followed(laneOf(view), Option.some(barsIn(0.5)), barsIn(0.9), false)).toEqual(Option.none())
  // Out past the right edge, into the next bar; round from the end of the loop to the start.
  expect(followed(laneOf(view), Option.some(barsIn(1) - 1), barsIn(1), false)).toEqual(Option.some(barWidth))
  const atFourth = { ...view, left: 3 * barWidth }
  expect(followed(laneOf(atFourth), Option.some(barsIn(4) - 1), 0, false)).toEqual(Option.some(0))
  // Scrolled away from it, the roll stays: before and now both out of sight; into sight again, it stays too.
  expect(followed(laneOf(atFourth), Option.some(barsIn(0.5)), barsIn(0.6), false)).toEqual(Option.none())
  expect(followed(laneOf(atFourth), Option.some(barsIn(3) - 1), barsIn(3), false)).toEqual(Option.none())
  // Out past the edge in a frame the roll was scrolled by hand, which took it there: the hand's, not the playhead's.
  expect(followed(laneOf(view), Option.some(barsIn(1) - 1), barsIn(1), true)).toEqual(Option.none())
})

test('in a roll narrower than a bar, the playhead is followed from the start of its beat, its step, or itself', () => {
  const beats = { ...view, width: keysWidth + widthOf(1.5 * ticksPerQuarter) }
  expect(followed(laneOf(beats), Option.some(1.4 * ticksPerQuarter), 1.5 * ticksPerQuarter, false)).toEqual(
    Option.some(widthOf(ticksPerQuarter))
  )
  const steps = { ...view, width: keysWidth + widthOf(1.5 * stepTicks) }
  expect(followed(laneOf(steps), Option.some(stepTicks), 5.5 * stepTicks, false)).toEqual(
    Option.some(widthOf(5 * stepTicks))
  )
  const narrow = { ...view, width: keysWidth + 4 }
  expect(followed(laneOf(narrow), Option.none(), 5.5 * stepTicks, false)).toEqual(Option.some(widthOf(5.5 * stepTicks)))
})

test('a click puts a note from the start of its step, on its row; over the keyboard, none', () => {
  expect(startAt(view, at(stepTicks * 2.7, 64))).toEqual(Option.some({ tick: stepTicks * 2, key: 64 }))
  expect(startAt(view, { x: keysWidth - 1, y: at(0, 64).y })).toEqual(Option.none())
})

test('of the notes under the pointer, the one drawn last is found; on its last tick still, past it not', () => {
  const long = note('a', 0, 64, stepTicks * 4)
  const over = note('b', stepTicks, 64, stepTicks)
  const notes = [long, over, note('c', 0, 65, stepTicks * 4)]
  expect(noteAt(notes, view, at(stepTicks * 1.5, 64))).toEqual(Option.some(over))
  expect(noteAt(notes, view, at(stepTicks * 3, 64))).toEqual(Option.some(long))
  expect(noteAt(notes, view, at(stepTicks * 4 - 1, 64))).toEqual(Option.some(long))
  expect(noteAt(notes, view, at(stepTicks * 4, 64))).toEqual(Option.none())
})

test('a drag finds every note on its way, each once, however far the pointer went between two moves', () => {
  const notes = [0, 2, 4, 6].map((step) => note(String(step), step * stepTicks, 64, stepTicks))
  const along = notesAlong(notes, view, at(stepTicks * 0.5, 64), at(stepTicks * 6.5, 64))
  expect(along.map(({ id }) => id)).toEqual(['0', '2', '4', '6'])
  expect(notesAlong(notes, view, at(stepTicks * 0.5, 64), at(stepTicks * 0.5, 64))).toHaveLength(1)
  // Across rows: down from E3 over D3 to C3.
  const steps = [note('e', 0, 64, stepTicks * 2), note('d', 0, 62, stepTicks * 2), note('c', 0, 60, stepTicks * 2)]
  expect(notesAlong(steps, view, at(stepTicks, 64), at(stepTicks, 60)).map(({ id }) => id)).toEqual(['e', 'd', 'c'])
})

test('past the roll no note is found, nor erased by a drag that goes on past it', () => {
  const shown = note('a', stepTicks * 2, 64, stepTicks)
  const past = note('b', stepTicks * 20, 64, stepTicks)
  const below = note('c', 0, 40, stepTicks)
  expect(noteAt([past], view, at(stepTicks * 20.5, 64))).toEqual(Option.none())
  expect(noteAt([below], view, at(stepTicks / 2, 40))).toEqual(Option.none())
  const along = notesAlong([shown, past], view, at(stepTicks * 2.5, 64), at(stepTicks * 24, 64))
  expect(along.map(({ id }) => id)).toEqual(['a'])
})

test('the roll opens with the notes in the middle, or middle C without them, and scrolls no further than its keys', () => {
  const height = rulerHeight + 24 * rowHeight
  const middleOf = (top: number) => Option.getOrThrow(keyAt({ ...view, top }, rulerHeight + 12 * rowHeight))
  expect(middleOf(centredOn([], height))).toBe(60)
  expect(middleOf(centredOn([note('a', 0, 48, 1), note('b', 0, 72, 1)], height))).toBe(60)
  expect(middleOf(centredOn([note('a', 0, 84, 1)], height))).toBe(84)
  expect(centredOn([note('a', 0, 127, 1)], height)).toBe(0)
  expect(scrolledTo(height, -5)).toBe(0)
  expect(scrolledTo(height, 10 ** 6)).toBe(128 * rowHeight - 24 * rowHeight)
})

test('the keys in sight are those whose rows show at least in part, highest first', () => {
  expect(keysInSight(view)).toEqual(Array.from({ length: 24 }, (_, i) => 72 - i))
  expect(keysInSight({ ...view, top: view.top + rowHeight / 2 })).toEqual(Array.from({ length: 25 }, (_, i) => 72 - i))
  expect(keysInSight({ ...view, top: 0 })[0]).toBe(127)
})

/** What a press takes hold of, by its tag, with the note it holds. */
const grabbed = (notes: ReadonlyArray<Note>, tick: number, key: number) =>
  Option.map(grabAt(notes, view, at(tick, key), stepTicks * 2), ({ _tag, note }) => ({ _tag, note }))

test("a press takes hold of a note by its body to move it, by its right edge to stretch it, a third of a narrow one's", () => {
  const long = note('a', 0, 64, stepTicks * 2)
  const narrow = note('b', stepTicks * 4, 64, stepTicks / 4)
  const notes = [long, narrow]
  const edge = (edgeWidth / stepWidth) * stepTicks
  expect(grabbed(notes, stepTicks, 64)).toEqual(Option.some({ _tag: 'Move', note: long }))
  expect(grabbed(notes, stepTicks * 2 - edge - 1, 64)).toEqual(Option.some({ _tag: 'Move', note: long }))
  expect(grabbed(notes, stepTicks * 2 - edge, 64)).toEqual(Option.some({ _tag: 'Stretch', note: long }))
  expect(grabbed(notes, stepTicks * 4 + stepTicks / 8, 64)).toEqual(Option.some({ _tag: 'Move', note: narrow }))
  expect(grabbed(notes, stepTicks * 4 + stepTicks / 6, 64)).toEqual(Option.some({ _tag: 'Stretch', note: narrow }))
  expect(cursorAt(notes, view, at(stepTicks, 64))).toBe('move')
  expect(cursorAt(notes, view, at(stepTicks * 2 - 1, 64))).toBe('stretch')
  expect(cursorAt(notes, view, at(stepTicks * 3, 64))).toBe('none')
})

test('a press on empty ground takes hold of a new note as long as asked; over the keyboard, of nothing', () => {
  expect(grabbed([], stepTicks * 2.5, 60)).toEqual(
    Option.some({ _tag: 'Put', note: { tick: stepTicks * 2, key: 60, length: stepTicks * 2 } })
  )
  expect(grabAt([], view, { x: keysWidth - 1, y: at(0, 60).y }, stepTicks)).toEqual(Option.none())
})

test('a new note goes with the pointer as a note moved, whole wherever it goes, past the end of the pattern too', () => {
  const put = Option.getOrThrow(grabAt([], view, at(stepTicks * 2.5, 60), stepTicks * 3))
  expect(draggedTo(put, view, at(stepTicks * 2.5, 60))).toEqual({ tick: stepTicks * 2, key: 60, length: stepTicks * 3 })
  expect(draggedTo(put, view, at(barTicks * 2 + stepTicks * 2.5, 62))).toEqual({
    tick: barTicks * 2 + stepTicks * 2,
    key: 62,
    length: stepTicks * 3
  })
})

/** Where the note held at the press stands with the pointer at the tick and key, on a roll as wide as the ticks. */
const dragged = (notes: ReadonlyArray<Note>, from: readonly [number, number], to: readonly [number, number]) => {
  const wide = { ...view, width: Number.POSITIVE_INFINITY }
  return Option.map(grabAt(notes, wide, at(...from), stepTicks), (grab) => draggedTo(grab, wide, at(...to)))
}

const place = (tick: number, key: number, length: number) => Option.some({ tick, key, length })

test('a note dragged moves by whole steps and keys, from the first tick on, past the end of the pattern too, among the keys', () => {
  const notes = [note('a', stepTicks * 4, 64, stepTicks * 2)]
  const from = [stepTicks * 4.5, 64] as const
  expect(dragged(notes, from, [stepTicks * 4.9, 64])).toEqual(place(stepTicks * 4, 64, stepTicks * 2))
  expect(dragged(notes, from, [stepTicks * 5.1, 66])).toEqual(place(stepTicks * 5, 66, stepTicks * 2))
  expect(dragged(notes, from, [stepTicks * 2.2, 63])).toEqual(place(stepTicks * 2, 63, stepTicks * 2))
  expect(dragged(notes, from, [-stepTicks * 20, 64])).toEqual(place(0, 64, stepTicks * 2))
  expect(dragged(notes, from, [stepTicks * 40.5, 64])).toEqual(place(stepTicks * 40, 64, stepTicks * 2))
  // No later than ends by the tick after the last, as the document takes it.
  const lastStep = Math.floor((lastTick + 1 - stepTicks * 2) / stepTicks) * stepTicks
  const late = [note('d', lastStep, 64, stepTicks * 2)]
  expect(dragged(late, [lastStep + stepTicks / 2, 64], [lastStep + stepTicks * 3.5, 64])).toEqual(
    place(lastStep, 64, stepTicks * 2)
  )
  // A note off the steps stays as far off them.
  expect(dragged([note('b', 5, 64, stepTicks)], [stepTicks / 2, 64], [stepTicks * 2.5, 64])).toEqual(
    place(stepTicks * 2 + 5, 64, stepTicks)
  )
})

test('a note dragged goes no higher than the highest key nor lower than the lowest, and follows the rows as they scroll', () => {
  const highest = { ...view, top: 0 }
  const top = note('a', 0, 126, stepTicks)
  const pressed = { x: xOf(highest, stepTicks / 2), y: yOf(highest, 126) + rowHeight / 2 }
  const grab = Option.getOrThrow(grabAt([top], highest, pressed, stepTicks))
  expect(draggedTo(grab, highest, { ...pressed, y: rulerHeight - 50 }).key).toBe(127)
  const bottom = note('b', 0, 1, stepTicks)
  const low = Option.getOrThrow(grabAt([bottom], view, at(stepTicks / 2, 1), stepTicks))
  expect(draggedTo(low, view, { ...at(stepTicks / 2, 1), y: at(0, 1).y + 10 * rowHeight }).key).toBe(0)
  // Scrolled down two rows under a still pointer: two keys lower; across three steps: three steps later.
  const held = Option.getOrThrow(grabAt([note('c', 0, 64, stepTicks)], view, at(stepTicks / 2, 64), stepTicks))
  expect(draggedTo(held, { ...view, top: view.top + 2 * rowHeight }, at(stepTicks / 2, 64)).key).toBe(62)
  expect(draggedTo(held, { ...view, left: 3 * stepWidth }, at(stepTicks / 2, 64)).tick).toBe(3 * stepTicks)
})

test("a note's right edge dragged makes it longer or shorter by whole steps, the least of them at least, past the end too", () => {
  const notes = [note('a', stepTicks * 4, 64, stepTicks * 2)]
  const edge = [stepTicks * 6 - 1, 64] as const
  expect(dragged(notes, edge, [stepTicks * 8.2, 70])).toEqual(place(stepTicks * 4, 64, stepTicks * 4))
  expect(dragged(notes, edge, [stepTicks * 5.2, 64])).toEqual(place(stepTicks * 4, 64, stepTicks))
  expect(dragged(notes, edge, [0, 64])).toEqual(place(stepTicks * 4, 64, stepTicks))
  expect(dragged(notes, edge, [stepTicks * 40, 64])).toEqual(place(stepTicks * 4, 64, stepTicks * 36))
  const late = [note('c', lastTick + 1 - stepTicks * 2, 64, stepTicks)]
  expect(dragged(late, [lastTick + 1 - stepTicks - 1, 64], [lastTick + stepTicks * 3, 64])).toEqual(
    place(lastTick + 1 - stepTicks * 2, 64, stepTicks * 2)
  )
  // One off the steps stays as far off them, down to its own least.
  const odd = [note('b', 0, 64, stepTicks + 5)]
  expect(dragged(odd, [stepTicks + 4, 64], [-stepTicks * 3, 64])).toEqual(place(0, 64, 5))
})

test('a drag shows the notes as the edit let go would make them, the note held on top; one erased meanwhile nowhere', () => {
  const held = note('a', 0, 64, stepTicks)
  const copy = note('copy', 0, 64, stepTicks * 2)
  const there = note('b', stepTicks * 2, 64, stepTicks * 4)
  const later = note('c', stepTicks * 8, 64, stepTicks)
  const notes = [copy, held, there, later]
  const grab = Option.getOrThrow(grabAt(notes, view, at(stepTicks / 2, 64), stepTicks))
  const to = { tick: Tick(stepTicks * 2), key: MidiKey(64), length: stepTicks }
  const moved = (one: Note) => ({ ...one, tick: to.tick })
  expect(draggedNotes(notes, grab, to)).toEqual([later, moved(copy), moved(held)])
  expect(draggedNotes([copy, there], grab, to)).toEqual([copy, there])
  const edge = Option.getOrThrow(grabAt([held], view, at(stepTicks - 1, 64), stepTicks))
  expect(draggedNotes([held, later], edge, { ...to, tick: held.tick, length: stepTicks * 3 })).toEqual([
    later,
    { ...held, length: stepTicks * 3 }
  ])
  const put = Option.getOrThrow(grabAt([later], view, at(stepTicks * 5, 60), stepTicks))
  expect(draggedNotes([there, later], put, to)).toEqual([later, to])
})
