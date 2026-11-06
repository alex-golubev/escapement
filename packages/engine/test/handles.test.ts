import { HashMap, Option } from 'effect'
import { expect, test } from 'vitest'
import {
  emptyNodeHandles,
  emptyPatternHandles,
  type HandleTable,
  handleOf,
  type NodeHandle,
  PatternHandle,
  releaseAll,
  releaseHandle,
  takeHandle
} from '../src/handles'

const taken = <H extends number>(table: HandleTable<H>) => Option.getOrThrow(takeHandle(table))

test('cells are handed out from 1, never 0', () => {
  const [first, table] = taken(emptyNodeHandles)
  const [second] = taken(table)
  expect([first, second]).toEqual([handleOf(0, 1), handleOf(0, 2)])
})

test('a released cell is taken again first, in its next generation', () => {
  const [first, one] = taken(emptyNodeHandles)
  const [, two] = taken(one)
  const released = releaseHandle(two, first)
  const [again, three] = taken(released)
  expect(again).toBe(handleOf(1, 1))
  expect(taken(three)[0]).toBe(handleOf(0, 3))
})

test('a handle that is not out changes nothing', () => {
  const [first, table] = taken(emptyNodeHandles)
  const released = releaseHandle(table, first)
  expect(releaseHandle(released, first)).toBe(released)
  expect(releaseHandle(table, handleOf(1, 1))).toBe(table)
  expect(releaseHandle(table, handleOf(0, 0))).toBe(table)
  expect(releaseHandle(table, handleOf(0, 9))).toBe(table)
})

test('after a reset every cell is free, the lowest first, and none comes back in a generation it had', () => {
  const [first, one] = taken(emptyNodeHandles)
  const [second, two] = taken(one)
  const [, three] = taken(releaseHandle(two, second))
  const reset = releaseAll(three)
  const [a, afterA] = taken(reset)
  const [b] = taken(afterA)
  expect([a, b]).toEqual([handleOf(1, 1), handleOf(2, 2)])
  expect([a, b]).not.toContain(first)
  expect([a, b]).not.toContain(second)
})

test('a generation wraps around after the last', () => {
  const [, one] = taken(emptyNodeHandles)
  // Cell 1 out in its last generation.
  const last: HandleTable<NodeHandle> = { ...one, generations: HashMap.make([1, 0xffff]) }
  expect(taken(releaseHandle(last, handleOf(0xffff, 1)))[0]).toBe(handleOf(0, 1))
})

test('none once every cell holds a node', () => {
  expect(Option.isNone(takeHandle({ ...emptyNodeHandles, next: 0x10000 }))).toBe(true)
  const [last] = taken({ ...emptyNodeHandles, next: 0xffff })
  expect(last).toBe(handleOf(0, 0xffff))
})

test("a pattern's table hands out its own handles in the same way, a reset included", () => {
  const [first, one] = taken(emptyPatternHandles)
  const [second] = taken(releaseHandle(one, first))
  const [again] = taken(releaseAll(one))
  expect([first, second, again]).toEqual([1, handleOf(1, 1), handleOf(1, 1)].map(PatternHandle))
})
