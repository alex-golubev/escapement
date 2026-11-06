// @vitest-environment happy-dom
import { Effect, Option } from 'effect'
import { afterEach, expect, test, vi } from 'vitest'
import reopenHtml from '../../public/reopen.html?raw'
import { pageReopenLayer } from '../../src/browser/reopen'
import { backKey, reopenPage } from '../../src/browser/reopen-page'
import { PageReopen, type Taken } from '../../src/services/reopen'

const taken: Taken = {
  hangs: [1000],
  playing: true,
  restarts: 2,
  hang: 'The audio thread stopped answering'
}

const opened = () => Effect.runSync(Effect.service(PageReopen).pipe(Effect.provide(pageReopenLayer)))

afterEach(() => {
  sessionStorage.clear()
  vi.restoreAllMocks()
})

test('the page leaves for the reopen page with what it takes along, and the reopened page reads it once', () => {
  const replace = vi.spyOn(location, 'replace').mockImplementation(() => {})
  const before = location.href
  const page = opened()
  expect(page.reopening()).toBe(false)
  Effect.runSync(page.reopen(taken))
  expect(page.reopening()).toBe(true)
  expect(replace).toHaveBeenCalledWith(`/${reopenPage}`)
  expect(sessionStorage.getItem(backKey)).toBe(before)
  expect(opened().taken).toEqual(Option.some(taken))
  // A reload later is no reopening.
  expect(opened().taken).toEqual(Option.none())
})

test("a page that can't leave keeps nothing for a reload to take as a reopening", () => {
  vi.spyOn(location, 'replace').mockImplementation(() => {
    throw new DOMException('Navigation is blocked', 'SecurityError')
  })
  const page = opened()
  expect(Effect.runSync(Effect.exit(page.reopen(taken)))._tag).toBe('Failure')
  // It stays: leaving asks again.
  expect(page.reopening()).toBe(false)
  expect(opened().taken).toEqual(Option.none())
})

test('what the tab keeps under the name, if not what the page took along, is nothing', () => {
  sessionStorage.setItem('escapement.reopened', JSON.stringify({ hangs: 'soon' }))
  expect(opened().taken).toEqual(Option.none())
  sessionStorage.setItem('escapement.reopened', '{')
  expect(opened().taken).toEqual(Option.none())
})

/** Runs the reopen page's script with the tab's storage; where it goes. */
const wentBack = (href: string) => {
  const script = reopenHtml.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? ''
  const went: Array<string> = []
  const at = new URL(href)
  const location = { href: at.href, origin: at.origin, replace: (to: string) => void went.push(to) }
  new Function('location', script)(location)
  return went
}

test('the reopen page goes straight back where the page said, only ever to its site', () => {
  sessionStorage.setItem(backKey, 'https://escapement.test/?project=1')
  expect(wentBack(`https://escapement.test/${reopenPage}`)).toEqual(['https://escapement.test/?project=1'])
  sessionStorage.setItem(backKey, 'https://elsewhere.test/')
  expect(wentBack(`https://escapement.test/${reopenPage}`)).toEqual(['/'])
  sessionStorage.removeItem(backKey)
  expect(wentBack(`https://escapement.test/${reopenPage}`)).toEqual(['https://escapement.test/'])
})
