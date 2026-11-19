import { Option } from 'effect'
import { expect, test } from 'vitest'
import { voicesNote } from '../../src/ui/views/track/track'

test('a device says how many notes it sounds at once, one as one, and nothing if it plays none', () => {
  expect(voicesNote(16)).toEqual(Option.some('16 voices'))
  expect(voicesNote(1)).toEqual(Option.some('1 voice'))
  expect(voicesNote(0)).toEqual(Option.none())
})
