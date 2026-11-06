import { Id } from '@escapement/model'
import { expect, test } from 'vitest'
import { Address, addressOf, appBase, projectHref } from '../../src/services/address'

test("a project's address opens it, by the ID it names; any other opens the list", () => {
  expect(addressOf('/project/AbC-_123', '/')).toEqual(Address.Project({ id: 'AbC-_123' }))
  expect(addressOf('/', '/')).toEqual(Address.Projects())
  expect(addressOf('/project/', '/')).toEqual(Address.Projects())
  expect(addressOf('/project/a/b', '/')).toEqual(Address.Projects())
  expect(addressOf('/elsewhere', '/')).toEqual(Address.Projects())
})

test('addresses are under the base the app is served at', () => {
  expect(addressOf('/app/project/AbC-_123', '/app/')).toEqual(Address.Project({ id: 'AbC-_123' }))
  expect(addressOf('/project/AbC-_123', '/app/')).toEqual(Address.Projects())
  expect(projectHref(Id('AbC-_123'))).toBe(`${appBase}project/AbC-_123`)
  expect(addressOf(projectHref(Id('AbC-_123')), appBase)).toEqual(Address.Project({ id: 'AbC-_123' }))
})
