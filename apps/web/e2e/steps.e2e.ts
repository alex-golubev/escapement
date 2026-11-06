import { expect, type Page } from '@playwright/test'
import { newProject, test } from './page'

// Four bars at the project's tempo are 8 s: round them once, within the test's 30 s.
const heard = { timeout: 20_000, polling: 'raf' } as const

/** The first step of Kick's bar. */
const kickStep = (page: Page, bar: number) =>
  page.getByRole('button', { name: `Kick, bar ${bar}, step 1`, exact: true })

/** Whether the step is heard now, shown whole right of the names, and not under them. */
const heardInSight = (page: Page, bar: number) =>
  page.waitForFunction(
    (label) => {
      const step = document.querySelector<HTMLElement>(`[aria-label="${label}"]`)
      const body = step?.closest('.dock-body')
      const names = document.querySelector('.seq-row:not(.seq-row--head) .seq-row__lead')
      const box = step?.getBoundingClientRect()
      return (
        step?.hasAttribute('data-now') === true &&
        box !== undefined &&
        box.left >= (names?.getBoundingClientRect().right ?? Number.POSITIVE_INFINITY) &&
        box.right <= (body?.getBoundingClientRect().right ?? 0)
      )
    },
    `Kick, bar ${bar}, step 1`,
    heard
  )

test('a kick put with steps into each of four bars: the Channels window grows across, the steps scroll under the names, and follow the playhead', async ({
  page
}) => {
  await newProject(page)
  // A new project's bar, and one past it to put steps in, as the window opens.
  await expect(kickStep(page, 2)).toBeInViewport({ ratio: 1 })
  await expect(kickStep(page, 3)).toHaveCount(0)
  const name = page.getByRole('button', { name: 'Kick', exact: true })
  const named = await name.boundingBox()
  const put = async (bar: number) => {
    await kickStep(page, bar).click()
    await expect(kickStep(page, bar)).toHaveAttribute('aria-pressed', 'true')
  }
  await put(1)
  await put(2)
  await put(3)
  // Past the window's edge, which the desk stops at: the click scrolls to it.
  await put(4)
  await expect(kickStep(page, 5)).toHaveCount(1)
  // The names stay where they were, and the steps scrolled to their place go under them.
  expect(await name.boundingBox()).toEqual(named)
  const under = await page.evaluate(() => {
    const names = document.querySelector('.seq-row:not(.seq-row--head) .seq-row__lead')?.getBoundingClientRect()
    return Array.from(document.querySelectorAll('.seq-row:not(.seq-row--head) .step'), (step) => {
      const box = step.getBoundingClientRect()
      return { label: step.getAttribute('aria-label') ?? '', x: box.left + box.width / 2, y: box.top + box.height / 2 }
    })
      .filter(({ x }) => x > (names?.left ?? 0) && x < (names?.right ?? 0))
      .map(({ label, x, y }) => ({
        label,
        covered: document.elementFromPoint(x, y)?.closest('.seq-row__lead') instanceof HTMLElement
      }))
  })
  expect(under.length).toBeGreaterThan(0)
  expect(under.every(({ covered }) => covered)).toBe(true)
  // A step under them the focus goes to comes out right of them.
  const covered = page.getByRole('button', { name: under[0]?.label ?? '', exact: true })
  await covered.focus()
  const names = await page.locator('.seq-row:not(.seq-row--head) .seq-row__lead').first().boundingBox()
  expect((await covered.boundingBox())?.x).toBeGreaterThanOrEqual((names?.x ?? 0) + (names?.width ?? 0))

  const play = page.getByRole('button', { name: 'Play', exact: true })
  await play.click()
  // From the first bar, as Play takes the Channels window to it, to the last and round again.
  await heardInSight(page, 1)
  await heardInSight(page, 4)
  await heardInSight(page, 1)
  await play.click()
  await expect(play).toHaveAttribute('aria-pressed', 'false')
})

test.describe('on a screen wider than the desk opens', () => {
  test.use({ viewport: { width: 1600, height: 720 } })

  test('the Channels window widened by its edge shows more bars past the pattern', async ({ page }) => {
    await newProject(page)
    await expect(kickStep(page, 2)).toBeInViewport({ ratio: 1 })
    await expect(kickStep(page, 3)).toHaveCount(0)
    const edge = await page
      .locator('.dv-resize-container', { has: page.getByRole('region', { name: 'Channels', exact: true }) })
      .locator('.dv-resize-handle-right')
      .first()
      .boundingBox()
    const x = (edge?.x ?? 0) + (edge?.width ?? 0) / 2
    const y = (edge?.y ?? 0) + (edge?.height ?? 0) / 2
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x + 400, y, { steps: 10 })
    await page.mouse.up()
    await expect(kickStep(page, 3)).toBeInViewport({ ratio: 1 })
    await expect(kickStep(page, 3)).toHaveAttribute('data-hint', /past the pattern's end/)
  })
})
