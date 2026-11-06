import { expect, test } from 'vitest'
import { newId } from '../src'

test('an ID is 16 characters of base64url, and no two are the same', () => {
  const ids = Array.from({ length: 10_000 }, newId)
  ids.forEach((id) => expect(id).toMatch(/^[A-Za-z0-9_-]{16}$/))
  expect(new Set(ids).size).toBe(ids.length)
})
