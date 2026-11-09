import { expect, type Page } from '@playwright/test'
import {
  arrangementLayout,
  drawnAt,
  listening,
  nameOf,
  newClip,
  putNote,
  remOf,
  rollAt,
  rollLayout,
  synths,
  test
} from './page'

// Pixels doubled, as on a Retina screen: a canvas laid out between them would blur.
test.use({ deviceScaleFactor: 2 })

interface Strip {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** Six pixels of the page across the point, one high: over a line down the grid. */
const across = (x: number, y: number): Strip => ({ x: x - 3, y, width: 6, height: 1 })

/** Six pixels of the page down through the point, one wide: over a line across the grid. */
const down = (x: number, y: number): Strip => ({ x, y: y - 3, width: 1, height: 6 })

/** How many colours the screen shows in the strip: a line drawn on whole points shows its own and its ground's, two. */
const coloursIn = async (page: Page, strip: Strip) =>
  page.evaluate(
    async (shot) => {
      const image = new Image()
      image.src = `data:image/png;base64,${shot}`
      await image.decode()
      const copy = new OffscreenCanvas(image.width, image.height)
      const g = copy.getContext('2d')
      g?.drawImage(image, 0, 0)
      const points = g?.getImageData(0, 0, image.width, image.height).data ?? new Uint8ClampedArray()
      return new Set(Array.from({ length: points.length / 4 }, (_, i) => points.slice(i * 4, i * 4 + 3).join())).size
    },
    (await page.screenshot({ clip: strip })).toString('base64')
  )

test('the page grows with its window as it is resized: heads with their rows, the same bars in sight, a click still in its bar and step, a menu at the pointer, lines sharp', async ({
  page
}) => {
  await synths(page, 2)
  // A clip in the seventh bar, scrolled across to it and ten pixels on: in the first bar in sight.
  await newClip(page, 6, 0, 'Synth')
  const head = page.locator('.track-head').first()
  expect(await remOf(page)).toBe(16)
  const small = await arrangementLayout(page)
  expect((await head.boundingBox())?.height).toBe(small.trackHeight)
  // Sent as the browser would: Playwright's own wheel halves it on a screen of doubled pixels.
  await page.locator('.arrangement__lanes').dispatchEvent('wheel', { deltaX: 6 * small.barWidth + 10, deltaMode: 0 })
  /** The bars scrolled past: the page grown takes them to a fraction of a pixel, which the screen has no point for. */
  const past = 6 + 10 / small.barWidth
  await expect
    .poll(() =>
      drawnAt(page, [
        [0, 0],
        [1, 0]
      ])
    )
    .toEqual([true, false])

  // A 27" iMac's window under the browser's bars: half as big again, less a little, a rem of a fraction of a pixel.
  await page.setViewportSize({ width: 2560, height: 1300 })
  await expect.poll(() => remOf(page)).toBeCloseTo(23.11, 2)
  const layout = await arrangementLayout(page)
  await expect.poll(async () => (await head.boundingBox())?.height).toBe(layout.trackHeight)
  // The clip put before stays the first bar in sight, drawn anew at the new size.
  await expect
    .poll(() =>
      drawnAt(page, [
        [0, 0],
        [1, 0]
      ])
    )
    .toEqual([true, false])

  // A double click in the third bar in sight of the second track puts a clip there; a click in the roll, a note in
  // its step.
  await newClip(page, 2, 1, 'Synth 2')
  await expect
    .poll(() =>
      drawnAt(page, [
        [2, 1],
        [1, 1],
        [3, 1],
        [2, 0]
      ])
    )
    .toEqual([true, false, false, false])
  await putNote(page, 3, 64)

  // Lines on whole points of the screen, in empty bars: the thirteenth bar's down the second track, the first track's
  // under it; and in the roll the line between E3 and F3, eight steps on.
  const box = await page.locator('.arrangement').boundingBox()
  const left = (box?.x ?? 0) + layout.headsWidth
  const top = (box?.y ?? 0) + layout.rulerHeight
  expect(await coloursIn(page, across(left + (12 - past) * layout.barWidth, top + 1.5 * layout.trackHeight))).toBe(2)
  expect(await coloursIn(page, down(left + 5.5 * layout.barWidth, top + layout.trackHeight))).toBe(2)
  const e3 = (await rollAt(page))(8, 64)
  expect(await coloursIn(page, down(e3.x, e3.y - (await rollLayout(page)).rowHeight / 2))).toBe(2)

  // A track's menu opens at the pointer.
  const name = await nameOf(page, 'Synth').boundingBox()
  const at = { x: (name?.x ?? 0) + 10, y: (name?.y ?? 0) + 5 }
  await page.mouse.click(at.x, at.y, { button: 'right' })
  const menu = page.getByRole('menu', { name: 'Synth', exact: true })
  await expect(menu).toBeVisible()
  const opened = await menu.boundingBox()
  expect(Math.abs((opened?.x ?? 0) - at.x)).toBeLessThanOrEqual(1)
  expect(Math.abs((opened?.y ?? 0) - at.y)).toBeLessThanOrEqual(1)
})

test("the mixer's rack shows the same strips as its window grows", async ({ page }) => {
  await synths(page, 24)
  await listening(page)
  const rack = page.locator('.rack')
  /** A strip and the gap after it, as the page lays them out. */
  const stepOf = async () => {
    const [first, second] = await Promise.all([0, 1].map((i) => page.locator('.rack .strip').nth(i).boundingBox()))
    return (second?.x ?? 0) - (first?.x ?? 0)
  }
  const step = await stepOf()
  // Two strips across: the first drawn the one before those in sight.
  await rack.evaluate((shown, left) => {
    shown.scrollLeft = left
  }, 2 * step)
  await expect(page.locator('.rack .strip__name').first()).toHaveText('Synth 2')
  await page.setViewportSize({ width: 1920, height: 1080 })
  await expect.poll(() => remOf(page)).toBeCloseTo(19.2, 2)
  await expect.poll(stepOf).toBeGreaterThan(step)
  const grown = await stepOf()
  await expect.poll(() => rack.evaluate((shown) => shown.scrollLeft)).toBeCloseTo(2 * grown, 0)
  await expect(page.locator('.rack .strip__name').first()).toHaveText('Synth 2')
})
