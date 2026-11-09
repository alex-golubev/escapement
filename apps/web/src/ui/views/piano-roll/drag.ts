import { highestKey, lastTick, lowestKey, MidiKey, Tick } from '@escapement/engine-description'
import { type NewNote, type Note, stepTicks, withMoved, withPut, withStretched } from '@escapement/model'
import { Array, Boolean, Data, Number, Option } from 'effect'
import { onRightEdge } from '../../kit/edge'
import type { Point } from '../../kit/pointer'
import { noteAt, rowAt, startAt, tickUnder, type View, widthOf, xOf } from './geometry'

/** Where on the roll a point is, as a key and a tick, past the roll's own too: a drag goes on outside it. */
interface Spot {
  readonly key: number
  readonly tick: number
}

const spotOf = (view: View, point: Point): Spot => ({ key: rowAt(view, point.y), tick: tickUnder(view, point.x) })

/**
 * What a press of the left button takes hold of, and where: a note by its body, to move, or by its right edge, to
 * stretch; on empty ground, a new note as long as asked, which moves until let go.
 */
export type Grab = Data.TaggedEnum<{
  Move: { readonly note: Note; readonly at: Spot }
  Stretch: { readonly note: Note; readonly at: Spot }
  Put: { readonly note: NewNote; readonly at: Spot }
}>

export const Grab = Data.taggedEnum<Grab>()

/** The cursor over what is held, or over what a press would take hold of. */
export type Cursor = 'move' | 'stretch' | 'none'

const onEdge = (view: View, note: Note, x: number) =>
  onRightEdge(x, xOf(view, note.tick + note.length), widthOf(view, note.length))

/** The note under the point, and whether by its right edge. */
const partAt = (notes: ReadonlyArray<Note>, view: View, point: Point) =>
  Option.map(noteAt(notes, view, point), (note) => ({ note, edge: onEdge(view, note, point.x) }))

/** What a press at the point takes hold of; a new note is `length` long. Nothing over the keyboard or the ruler. */
export const grabAt = (notes: ReadonlyArray<Note>, view: View, point: Point, length: number): Option.Option<Grab> => {
  const at = spotOf(view, point)
  return Option.match(partAt(notes, view, point), {
    onSome: ({ note, edge }) =>
      Option.some(
        Boolean.match(edge, { onTrue: () => Grab.Stretch({ note, at }), onFalse: () => Grab.Move({ note, at }) })
      ),
    onNone: () => Option.map(startAt(view, point), (start) => Grab.Put({ note: { ...start, length }, at }))
  })
}

export const cursorAt = (notes: ReadonlyArray<Note>, view: View, point: Point): Cursor =>
  Option.match(partAt(notes, view, point), {
    onNone: () => 'none',
    onSome: ({ edge }) => Boolean.match(edge, { onTrue: () => 'stretch', onFalse: () => 'move' })
  })

export const cursorOf = Grab.$match({
  Move: (): Cursor => 'move',
  Stretch: (): Cursor => 'stretch',
  Put: (): Cursor => 'move'
})

/** As far as a note may end: the tick after the last. */
const latestEnd = lastTick + 1

/** Whole steps from one spot to the other, from `fewest` to `most`; none later for a note already past `latestEnd`. */
const stepsWithin = (from: Spot, to: Spot, fewest: number, most: number) =>
  Number.clamp(Math.round((to.tick - from.tick) / stepTicks), { minimum: fewest, maximum: Math.max(most, 0) })

/** Whole steps later the note may go, or longer: ending by `latestEnd`, as the document takes it. */
const stepsLeft = ({ tick, length }: NewNote) => Math.floor((latestEnd - tick - length) / stepTicks)

/**
 * Moved by whole steps and keys: from the first tick on, among the keys there are. Later as far as it goes, the pattern
 * growing to it.
 */
const moved = (note: NewNote, from: Spot, to: Spot): NewNote => ({
  tick: Tick(note.tick + stepsWithin(from, to, -Math.floor(note.tick / stepTicks), stepsLeft(note)) * stepTicks),
  key: MidiKey(Number.clamp(note.key + to.key - from.key, { minimum: lowestKey, maximum: highestKey })),
  length: note.length
})

/** Longer or shorter by whole steps, not shorter than the least of them. */
const stretched = (note: NewNote, from: Spot, to: Spot): NewNote => ({
  tick: note.tick,
  key: note.key,
  length: note.length + stepsWithin(from, to, -Math.floor((note.length - 1) / stepTicks), stepsLeft(note)) * stepTicks
})

/** Where the note held stands with the pointer at the point; at the press, where it was, or a new one's place. */
export const draggedTo = (grab: Grab, view: View, point: Point): NewNote => {
  const to = spotOf(view, point)
  const move = ({ note, at }: { readonly note: NewNote; readonly at: Spot }) => moved(note, at, to)
  return Grab.$match(grab, {
    Move: move,
    Put: move,
    Stretch: ({ note, at }) => stretched(note, at, to)
  })
}

/**
 * The clip's notes as a drag shows them: as the edit let go there would make them, the note held on top. One gone from
 * the document meanwhile shows nowhere.
 */
export const draggedNotes = (notes: ReadonlyArray<Note>, grab: Grab, place: NewNote): ReadonlyArray<NewNote> => {
  const held = (note: Note, edit: (now: Note) => ReadonlyArray<Note>) =>
    Option.match(
      Array.findFirst(notes, (now) => now.id === note.id),
      { onNone: () => notes, onSome: edit }
    )
  return Grab.$match(grab, {
    Move: ({ note }) => held(note, (now) => withMoved(notes, now, place)),
    Stretch: ({ note }) => held(note, (now) => withStretched(notes, now, place.length)),
    Put: () => withPut<NewNote>(notes, place)
  })
}
