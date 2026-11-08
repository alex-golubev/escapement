import { expect, type Page } from '@playwright/test'
import { reload, showCentre, synths, test } from './page'

/** What must stay in sight whatever the panel's height: the page's controls over and under it, and its own. */
const inSight = ['.transport', '.workspace__border', '.panel__title', '.panel__fold', '.hint']

/** How high the middle and the panel are, how far the page itself scrolls, and what of `inSight` is out of it. */
const laidOut = (page: Page) =>
  page.evaluate((inSight) => {
    const box = (selector: string) => document.querySelector(selector)?.getBoundingClientRect()
    return {
      centre: box('.workspace__centre')?.height,
      panel: box('.panel')?.height,
      scrolls: [document.documentElement.scrollHeight - innerHeight, document.documentElement.scrollWidth - innerWidth],
      out: inSight.filter((selector) => {
        const shown = box(selector)
        return shown === undefined || shown.top < 0 || shown.bottom > innerHeight
      })
    }
  }, inSight)

/** Nothing cut off: the page doesn't scroll, and all that must be in sight is. */
const nothingCutOff = async (page: Page) => expect(await laidOut(page)).toMatchObject({ scrolls: [0, 0], out: [] })

/** The border between the middle and the panel dragged to `y` on the page. */
const dragBorder = async (page: Page, y: number) => {
  const border = await page.locator('.workspace__border').boundingBox()
  const x = (border?.x ?? 0) + (border?.width ?? 0) / 2
  await page.mouse.move(x, (border?.y ?? 0) + (border?.height ?? 0) / 2)
  await page.mouse.down()
  await page.mouse.move(x, y, { steps: 10 })
  await page.mouse.up()
}

const arrow = (page: Page) => page.locator('.panel__fold')

test('the border takes the panel up to the least the middle has and down past its own, folding it; nothing is ever cut off', async ({
  page
}) => {
  await synths(page, 1)
  await nothingCutOff(page)
  await dragBorder(page, 0)
  expect((await laidOut(page)).centre).toBeCloseTo(120, 0)
  await nothingCutOff(page)
  await dragBorder(page, 720)
  await expect(arrow(page)).toHaveAttribute('aria-expanded', 'false')
  expect((await laidOut(page)).panel).toBeCloseTo(28, 0)
  await nothingCutOff(page)
  // Unfolded to the height it had before the drag that folded it.
  await arrow(page).click()
  await expect(arrow(page)).toHaveAttribute('aria-expanded', 'true')
  expect((await laidOut(page)).centre).toBeCloseTo(120, 0)
  await nothingCutOff(page)
})

test('a window too low for the panel folds it, and its arrow says so; grown again, the panel unfolds as it was', async ({
  page
}) => {
  await synths(page, 1)
  await dragBorder(page, 560)
  const { panel } = await laidOut(page)
  await page.setViewportSize({ width: 1280, height: 360 })
  await expect(arrow(page)).toHaveAttribute('aria-expanded', 'false')
  expect((await laidOut(page)).panel).toBeCloseTo(28, 0)
  await page.setViewportSize({ width: 1280, height: 720 })
  await expect(arrow(page)).toHaveAttribute('aria-expanded', 'true')
  await expect.poll(async () => (await laidOut(page)).panel).toBeCloseTo(panel ?? 0, 0)
})

/** How far down the Arrangement is scrolled: its heads go up as far. */
const arrangementDown = (page: Page) =>
  page.locator('.track-heads__rows').evaluate((rows) => -new DOMMatrix(getComputedStyle(rows).transform).m42)

const rackAcross = (page: Page) => page.locator('.rack').evaluate((rack) => rack.scrollLeft)

/** The scroll this browser keeps for the open project, as written to IndexedDB; none before it is. */
const keptScroll = (page: Page) =>
  page.evaluate(async () => {
    const done = <A>(request: IDBRequest<A>) => {
      const answered = Promise.withResolvers<A>()
      request.onsuccess = () => answered.resolve(request.result)
      request.onerror = () => answered.reject(request.error)
      return answered.promise
    }
    // The store of views the page opens, and the table Effect keeps its entries in.
    const db = await done(indexedDB.open('escapement-view'))
    const key = `layout:${location.pathname.split('/').pop()}`
    const entry: { readonly value: string } | undefined = await done(
      db.transaction('entries', 'readonly').objectStore('entries').get(key)
    )
    db.close()
    return JSON.parse(entry?.value ?? '{}').scroll
  })

test("the panel's height and fold, and how far the Arrangement and the rack are scrolled, come back with the page", async ({
  page
}) => {
  await synths(page, 12)
  await dragBorder(page, 300)
  const { panel } = await laidOut(page)
  const arrangement = await page.locator('.arrangement').boundingBox()
  await page.mouse.move((arrangement?.x ?? 0) + 400, (arrangement?.y ?? 0) + 60)
  await page.mouse.wheel(0, 10 ** 5)
  await expect.poll(() => arrangementDown(page)).toBeGreaterThan(0)
  const down = await arrangementDown(page)
  await showCentre(page, 'Mix')
  const rack = await page.locator('.rack').boundingBox()
  await page.mouse.move((rack?.x ?? 0) + 100, (rack?.y ?? 0) + 40)
  await page.mouse.wheel(1600, 0)
  await expect.poll(() => rackAcross(page)).toBeGreaterThan(0)
  const across = await rackAcross(page)
  await arrow(page).click()
  await expect(arrow(page)).toHaveAttribute('aria-expanded', 'false')
  // The scroll is written once it stands.
  await expect.poll(() => keptScroll(page)).toEqual({ arrangement: { down, across: 0 }, rack: across })
  await reload(page)
  await expect(page.locator('.strip--master')).toBeVisible()
  await expect.poll(() => rackAcross(page)).toBe(across)
  await expect(arrow(page)).toHaveAttribute('aria-expanded', 'false')
  await arrow(page).click()
  await expect.poll(async () => (await laidOut(page)).panel).toBeCloseTo(panel ?? 0, 0)
  await showCentre(page, 'Arrange')
  await expect.poll(() => arrangementDown(page)).toBe(down)
  await nothingCutOff(page)
})
