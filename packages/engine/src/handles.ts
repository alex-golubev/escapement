import { Boolean, Brand, HashMap, HashSet, Option } from 'effect'

/** A node's cell from 1 in the low 16 bits, the cell's generation above. */
export type NodeHandle = Brand.Branded<number, 'NodeHandle'>

/** Only the handle table and tests make handles of numbers. */
export const NodeHandle = Brand.nominal<NodeHandle>()

/** A pattern's, as a node's, of a table of its own: it never names a node. */
export type PatternHandle = Brand.Branded<number, 'PatternHandle'>

export const PatternHandle = Brand.nominal<PatternHandle>()

const maxCell = 0xffff

/** Unsigned: a generation from 0x8000 up would turn a plain shift negative. */
const rawHandle = (generation: number, cell: number) => ((generation << 16) | cell) >>> 0

/** A node's handle of a cell in its generation. */
export const handleOf = (generation: number, cell: number) => NodeHandle(rawHandle(generation, cell))

/** Cells to take again, the next one first. */
type Free = { readonly cell: number; readonly rest: Free } | undefined

/** Hands out handles of one kind: a free cell, in a new generation each time it is taken again. */
export interface HandleTable<H extends number> {
  /** Makes a number a handle of the table's kind. */
  readonly kind: (raw: number) => H
  /** The first cell never handed out; cell 0 is never a handle's. */
  readonly next: number
  /** A cell's generation for its next node, once it has had one. */
  readonly generations: HashMap.HashMap<number, number>
  readonly taken: HashSet.HashSet<number>
  readonly free: Free
}

const emptyHandleTable = <H extends number>(kind: (raw: number) => H): HandleTable<H> => ({
  kind,
  next: 1,
  generations: HashMap.empty(),
  taken: HashSet.empty(),
  free: undefined
})

export const emptyNodeHandles = emptyHandleTable(NodeHandle)

export const emptyPatternHandles = emptyHandleTable(PatternHandle)

const generationOf = <H extends number>(table: HandleTable<H>, cell: number) =>
  Option.getOrElse(HashMap.get(table.generations, cell), () => 0)

/** None once every cell holds one. */
export const takeHandle = <H extends number>(table: HandleTable<H>): Option.Option<readonly [H, HandleTable<H>]> =>
  Option.match(Option.fromUndefinedOr(table.free), {
    onSome: ({ cell, rest }) =>
      Option.some([
        table.kind(rawHandle(generationOf(table, cell), cell)),
        { ...table, taken: HashSet.add(table.taken, cell), free: rest }
      ] as const),
    onNone: () =>
      Option.map(
        Option.liftPredicate(table.next, (next) => next <= maxCell),
        (next) =>
          [table.kind(rawHandle(0, next)), { ...table, next: next + 1, taken: HashSet.add(table.taken, next) }] as const
      )
  })

const nextGeneration = (generation: number) => (generation + 1) & 0xffff

/** Its cell is free again, in its next generation; a handle that isn't out changes nothing. */
export const releaseHandle = <H extends number>(table: HandleTable<H>, handle: H): HandleTable<H> => {
  const cell = handle & maxCell
  const out = HashSet.has(table.taken, cell) && generationOf(table, cell) === handle >>> 16
  return Boolean.match(out, {
    onFalse: () => table,
    onTrue: () => ({
      ...table,
      generations: HashMap.set(table.generations, cell, nextGeneration(generationOf(table, cell))),
      taken: HashSet.remove(table.taken, cell),
      free: { cell, rest: table.free }
    })
  })
}

/** As a reset leaves it: every cell free, the lowest first, each one taken in its next generation. */
export const releaseAll = <H extends number>(table: HandleTable<H>): HandleTable<H> => ({
  kind: table.kind,
  next: table.next,
  generations: HashSet.reduce(table.taken, table.generations, (generations, cell) =>
    HashMap.set(generations, cell, nextGeneration(generationOf(table, cell)))
  ),
  taken: HashSet.empty(),
  free: Array.from({ length: table.next - 1 }, (_, i) => table.next - 1 - i).reduce<Free>(
    (rest, cell) => ({ cell, rest }),
    undefined
  )
})
