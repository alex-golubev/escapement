import { Array, Option, Record } from 'effect'
import { Id } from './id'

/** The mixer's inserts besides the master, built in: none are added. */
export const insertCount = 500

/** The insert every channel goes into unless it goes into another, and every other insert goes into. */
export const master = Id('master')

/**
 * The mixer's inserts besides the master, in their order: built in, each with an ID of its own. The document holds
 * nothing of an insert until it has something of its own.
 */
export const mixerInserts: ReadonlyArray<Id> = Array.makeBy(insertCount, (i) => Id(String(i + 1)))

/** The master, then the others, each at its number. */
const numbered: ReadonlyArray<Id> = [master, ...mixerInserts]

const numbers: Readonly<Record<string, number>> = Record.fromEntries(numbered.map((id, i) => [id, i] as const))

/** The insert's number on the mixer, 0 for the master; none for an ID that names no insert. */
export const insertNumber = (insert: string): Option.Option<number> => Record.get(numbers, insert)

/** The insert of this number, 0 the master; none for one that names no insert. */
export const insertOfNumber = (number: number): Option.Option<Id> =>
  Option.flatMap(Option.liftPredicate(number, Number.isInteger), (whole) => Array.get(numbered, whole))
