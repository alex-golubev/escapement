import type { Note } from './project'

/** Where a note plays: notes of one pattern at one tick and key play as one and look as one. */
export type NotePlace = Pick<Note, 'tick' | 'key'>

export const samePlace = (a: NotePlace, b: NotePlace) => a.tick === b.tick && a.key === b.key

// What an edit makes of a pattern's notes, for the edit to write and a drag to show: the notes it changes come last.

/** With the note put, in place of the notes in its place. */
export const withPut = <N extends NotePlace>(notes: ReadonlyArray<N>, note: N): ReadonlyArray<N> => [
  ...notes.filter((other) => !samePlace(other, note)),
  note
]

/** With the note and the notes in its place moved to start and be as high as asked, in place of the notes there. */
export const withMoved = (
  notes: ReadonlyArray<Note>,
  moved: Note,
  to: Pick<Note, 'tick' | 'key'>
): ReadonlyArray<Note> => [
  ...notes.filter((note) => !samePlace(note, moved) && !samePlace(note, to)),
  ...notes.filter((note) => samePlace(note, moved)).map((note) => ({ ...note, tick: to.tick, key: to.key }))
]

/** With the note and the notes in its place as long as asked. */
export const withStretched = (notes: ReadonlyArray<Note>, stretched: Note, length: number): ReadonlyArray<Note> => [
  ...notes.filter((note) => !samePlace(note, stretched)),
  ...notes.filter((note) => samePlace(note, stretched)).map((note) => ({ ...note, length }))
]
