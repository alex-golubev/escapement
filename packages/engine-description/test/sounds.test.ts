import { expect, test } from 'vitest'
import { Sha256 } from '../src/sounds'

test('a sound is named by its SHA-256 in lowercase hex', () => {
  const hash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
  expect(Sha256(hash)).toBe(hash)
  const notHashes = [hash.toUpperCase(), hash.slice(1), `${hash}0`, `${hash.slice(1)}g`, '']
  notHashes.forEach((hex) => expect(() => Sha256(hex)).toThrow('not a SHA-256 in hex'))
})
