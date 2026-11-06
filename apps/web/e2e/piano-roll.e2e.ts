import { expect, type Locator, type Page } from '@playwright/test'
import { keysWidth, rowHeight, rulerHeight, stepWidth } from '../src/ui/windows/piano-roll/layout'
import { newProject, test } from './page'

/** The steps of a bar, as the step sequencer shows them. */
const barSteps = 16

/**
 * Where the playhead is across the preview of the notes, in the Channels window's bars: from one bar of its steps to
 * the next.
 */
const nowIn = (preview: Locator) => () =>
  preview.evaluate((element) => {
    const [first, second] = Array.from(
      document.querySelectorAll('.seq-row--head .bar'),
      (bar) => bar.getBoundingClientRect().left
    )
    return Number.parseFloat(element.style.getPropertyValue('--now-x')) / ((second ?? 0) - (first ?? 0))
  })

const heard = { timeout: 10_000, polling: 'raf' } as const

/**
 * Where on the page the piano roll has the key's row at the step: it opens with no notes centred on middle C, the
 * middle of C3's row in the middle of the rows.
 */
const rollAt = async (page: Page) => {
  const box = await page.locator('.roll').boundingBox()
  const left = box?.x ?? 0
  const top = box?.y ?? 0
  const middle = top + rulerHeight + ((box?.height ?? 0) - rulerHeight) / 2
  return (step: number, key: number) => ({
    x: left + keysWidth + (step + 0.5) * stepWidth,
    y: middle - (key - 60) * rowHeight
  })
}

/** A new project with a synth added, and the piano roll open on it at the size it opens at. */
const synthRoll = async (page: Page) => {
  await newProject(page)
  await page.getByRole('button', { name: 'Add a channel', exact: true }).click()
  const synth = page.getByRole('button', { name: 'Synth', exact: true })
  // Once the Channels window has grown to show the new row whole, a frame after it came.
  await expect(synth).toBeInViewport({ ratio: 1 })
  const box = await synth.boundingBox()
  await page.mouse.click((box?.x ?? 0) + 10, (box?.y ?? 0) + 5, { button: 'right' })
  await page.getByRole('menu', { name: 'Synth', exact: true }).getByRole('menuitem', { name: 'Piano roll' }).click()
  await expect(page.locator('.dock-tab', { hasText: 'Piano roll' }).locator('.dock-tab__sub')).toHaveText('Synth')
  // A bar of steps beside the keyboard, no more and no less, once the dock has given the window the size it opens at.
  await expect
    .poll(async () => (await page.locator('.roll').boundingBox())?.width)
    .toBe(keysWidth + barSteps * stepWidth)
}

/** The colour the roll's canvas, of the grid or of the notes, draws at the point. */
const pixelAt = (page: Page, layer: 'grid' | 'notes', { x, y }: { readonly x: number; readonly y: number }) =>
  page.evaluate(
    ([layer, x, y]) => {
      const canvas = document.querySelectorAll<HTMLCanvasElement>('.roll canvas')[{ grid: 0, notes: 1 }[layer]]
      const box = canvas.getBoundingClientRect()
      const scale = canvas.width / box.width
      // Read from a copy, once: the browser warns of a canvas read again and again.
      const copy = document.createElement('canvas')
      copy.width = 1
      copy.height = 1
      const g = copy.getContext('2d')
      g?.drawImage(canvas, (x - box.left) * scale, (y - box.top) * scale, 1, 1, 0, 0, 1, 1)
      return Array.from(g?.getImageData(0, 0, 1, 1).data ?? [])
    },
    [layer, x, y] as const
  )

/** Whether the roll draws a note at the point: its notes' canvas is clear elsewhere. */
const noteDrawn = async (page: Page, point: { readonly x: number; readonly y: number }) =>
  ((await pixelAt(page, 'notes', point))[3] ?? 0) > 0

test('a melody put into the piano roll plays on the synth; erased, the steps come back, and Cmd+Z brings it back', async ({
  page
}) => {
  await synthRoll(page)
  const window = page.getByRole('region', { name: 'Piano roll', exact: true }).first()
  // Whole, at the tests' 1280 by 720, under the Channels window as it has grown with the channel added.
  await expect(window).toBeInViewport({ ratio: 1 })
  const channels = await page.getByRole('region', { name: 'Channels', exact: true }).first().boundingBox()
  expect((await window.boundingBox())?.y).toBeGreaterThan((channels?.y ?? 0) + (channels?.height ?? 0))
  const at = await rollAt(page)
  const clicked = async (step: number, key: number, button: 'left' | 'right' = 'left') => {
    const { x, y } = at(step, key)
    await page.mouse.click(x, y, { button })
  }
  // C3, then E3 twice and G3: the last three no step's notes.
  await clicked(0, 60)
  await clicked(4, 64)
  await clicked(6, 64)
  await clicked(8, 67)
  const preview = page.getByRole('button', { name: 'Synth: notes', exact: true })
  await expect(preview).toBeVisible()
  await expect(page.getByRole('button', { name: 'Synth, bar 1, step 1', exact: true })).toHaveCount(0)
  // Where the steps were, as the rows above have theirs.
  const steps = await page.locator('.seq-row', { hasText: 'Kick' }).locator('.steps').boundingBox()
  const shown = await preview.boundingBox()
  expect([shown?.x, shown?.width]).toEqual([steps?.x, steps?.width])

  const play = page.getByRole('button', { name: 'Play', exact: true })
  await play.click()
  await page.waitForFunction(
    () => document.querySelector('[aria-label="Synth: notes"][data-now]') !== null,
    undefined,
    heard
  )
  await page.waitForFunction(
    () =>
      Array.from(document.querySelectorAll<HTMLElement>('.strip--master .meter__fill')).some(
        (fill) => Number(fill.style.getPropertyValue('--level')) > 0
      ),
    undefined,
    heard
  )
  await play.click()
  await expect(play).toHaveAttribute('aria-pressed', 'false')

  // A drag with the right button along E3 takes both; a right click, G3. C3 is a step's note.
  const from = at(4, 64)
  const to = at(6, 64)
  await page.mouse.move(from.x, from.y)
  await page.mouse.down({ button: 'right' })
  await page.mouse.move(to.x, to.y, { steps: 4 })
  await page.mouse.up({ button: 'right' })
  await clicked(8, 67, 'right')
  const first = page.getByRole('button', { name: 'Synth, bar 1, step 1', exact: true })
  await expect(first).toHaveAttribute('aria-pressed', 'true')
  await expect(preview).toHaveCount(0)
  await page.keyboard.press('ControlOrMeta+z')
  await expect(preview).toBeVisible()
  await expect(page.locator('.transport').getByRole('status')).toHaveText('')
})

test('a note dragged in the piano roll moves, its right edge stretches it, each written once let go as one step of undo', async ({
  page
}) => {
  await synthRoll(page)
  const at = await rollAt(page)
  const first = page.getByRole('button', { name: 'Synth, bar 1, step 1', exact: true })
  const preview = page.getByRole('button', { name: 'Synth: notes', exact: true })
  const drawnAt = (step: number, key: number) => expect.poll(() => noteDrawn(page, at(step, key)))
  const c5 = at(0, 60)
  await page.mouse.click(c5.x, c5.y)
  await expect(first).toHaveAttribute('aria-pressed', 'true')

  // Up to E3 three steps on: drawn there at once, written only once let go, when it is no step's note.
  const e5 = at(3, 64)
  await page.mouse.move(c5.x, c5.y)
  await page.mouse.down()
  await page.mouse.move(e5.x, e5.y, { steps: 6 })
  await drawnAt(3, 64).toBe(true)
  await drawnAt(0, 60).toBe(false)
  await expect(first).toHaveAttribute('aria-pressed', 'true')
  await page.mouse.up()
  await expect(preview).toBeVisible()

  // By the last pixels of its step, two steps longer.
  const edge = { x: e5.x + stepWidth / 2 - 2, y: e5.y }
  await page.mouse.move(edge.x, edge.y)
  await expect(page.locator('.roll')).toHaveAttribute('data-grab', 'stretch')
  await page.mouse.down()
  await page.mouse.move(edge.x + 2 * stepWidth, edge.y, { steps: 6 })
  await page.mouse.up()
  await drawnAt(5, 64).toBe(true)
  await drawnAt(6, 64).toBe(false)

  await page.keyboard.press('ControlOrMeta+z')
  await drawnAt(5, 64).toBe(false)
  await drawnAt(3, 64).toBe(true)
  await page.keyboard.press('ControlOrMeta+z')
  await expect(first).toHaveAttribute('aria-pressed', 'true')
  await expect(preview).toHaveCount(0)
})

test('a note dragged past the window into the second bar makes a melody of two bars, which plays whole, round and round', async ({
  page
}) => {
  await synthRoll(page)
  const at = await rollAt(page)
  const c5 = at(0, 60)
  const e5 = at(8, 64)
  await page.mouse.click(c5.x, c5.y)
  await page.mouse.click(e5.x, e5.y)
  // Past the window's right edge: the roll holds the pointer.
  const later = at(8 + barSteps, 64)
  await page.mouse.move(e5.x, e5.y)
  await page.mouse.down()
  await page.mouse.move(later.x, later.y, { steps: 10 })
  await page.mouse.up()
  const preview = page.getByRole('button', { name: 'Synth: notes', exact: true })
  await expect(preview).toBeVisible()
  const now = nowIn(preview)
  const play = page.getByRole('button', { name: 'Play', exact: true })
  await play.click()
  // Into the second bar, then round from the start.
  await expect.poll(now, heard).toBeGreaterThan(1.2)
  await expect.poll(now, heard).toBeLessThan(0.4)
  await page.waitForFunction(
    () =>
      Array.from(document.querySelectorAll<HTMLElement>('.strip--master .meter__fill')).some(
        (fill) => Number(fill.style.getPropertyValue('--level')) > 0
      ),
    undefined,
    heard
  )
  await play.click()
  await expect(play).toHaveAttribute('aria-pressed', 'false')
})

test('a roll two bars wide shows the second past the pattern until a note goes into it, already while it is held', async ({
  page
}) => {
  await synthRoll(page)
  // Wider by the floating window's right edge.
  const window = page.getByRole('region', { name: 'Piano roll', exact: true }).first()
  const edge = await page
    .locator('.dv-resize-container', { has: window })
    .locator('.dv-resize-handle-right')
    .boundingBox()
  const from = { x: (edge?.x ?? 0) + (edge?.width ?? 0) / 2, y: (edge?.y ?? 0) + (edge?.height ?? 0) / 2 }
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + barSteps * stepWidth + 20, from.y, { steps: 10 })
  await page.mouse.up()
  await expect
    .poll(async () => (await page.locator('.roll').boundingBox())?.width ?? 0)
    .toBeGreaterThan(keysWidth + (barSteps + 6) * stepWidth)
  const at = await rollAt(page)
  const c5 = at(0, 60)
  await page.mouse.click(c5.x, c5.y)
  // Empty ground in the first bar and in the second, on one row.
  const inPattern = () => pixelAt(page, 'grid', at(4, 64))
  const inSecond = () => pixelAt(page, 'grid', at(barSteps + 4, 64))
  const shownPast = async () => JSON.stringify(await inSecond()) !== JSON.stringify(await inPattern())
  await expect.poll(shownPast).toBe(true)
  const later = at(barSteps + 2, 60)
  const back = at(2, 60)
  await page.mouse.move(c5.x, c5.y)
  await page.mouse.down()
  await page.mouse.move(later.x, later.y, { steps: 10 })
  await expect.poll(shownPast).toBe(false)
  await page.mouse.up()
  // Back from it: past again while held, the note it has no more.
  await page.mouse.down()
  await page.mouse.move(back.x, back.y, { steps: 10 })
  await expect.poll(shownPast).toBe(true)
  await page.mouse.up()
  await expect.poll(shownPast).toBe(true)
})

test('a melody of four bars put in a roll a bar wide, scrolled across bar by bar, plays whole, the roll going with the playhead', async ({
  page
}) => {
  await synthRoll(page)
  const at = await rollAt(page)
  const bar = barSteps * stepWidth
  const c5 = at(0, 60)
  await page.mouse.click(c5.x, c5.y)
  // A bar on each time, the pattern growing a bar with each note: by Shift and the wheel, then sideways, as a swipe.
  await page.keyboard.down('Shift')
  await page.mouse.wheel(0, bar)
  await page.keyboard.up('Shift')
  await page.mouse.click(c5.x, at(0, 62).y)
  await page.mouse.wheel(bar, 0)
  await page.mouse.click(c5.x, at(0, 64).y)
  await page.mouse.wheel(bar, 0)
  await page.mouse.click(c5.x, at(0, 67).y)
  const drawnAt = (key: number) => expect.poll(() => noteDrawn(page, at(0, key)), heard)
  await drawnAt(67).toBe(true)
  await drawnAt(64).toBe(false)
  // Back to the first bar, then played: the roll takes each bar's note under the same point in turn.
  await page.mouse.wheel(-4 * bar, 0)
  await drawnAt(60).toBe(true)
  const play = page.getByRole('button', { name: 'Play', exact: true })
  await play.click()
  await drawnAt(62).toBe(true)
  await drawnAt(64).toBe(true)
  await drawnAt(67).toBe(true)
  await drawnAt(60).toBe(true)
  const preview = page.getByRole('button', { name: 'Synth: notes', exact: true })
  await expect.poll(nowIn(preview), heard).toBeGreaterThan(3)
  await play.click()
  await expect(play).toHaveAttribute('aria-pressed', 'false')
})

test('a key of the piano roll pressed sounds on the synth while held, falls silent once let go of, and puts no note', async ({
  page
}) => {
  await synthRoll(page)
  const at = await rollAt(page)
  const level = () =>
    page.evaluate(() =>
      Math.max(
        ...Array.from(document.querySelectorAll<HTMLElement>('.strip--master .meter__fill')).map((fill) =>
          Number(fill.style.getPropertyValue('--level'))
        )
      )
    )
  // Left of the first step: C3 on the keyboard.
  const c5 = at(-1, 60)
  await page.mouse.move(c5.x, c5.y)
  await page.mouse.down()
  await expect.poll(level, heard).toBeGreaterThan(0)
  await page.mouse.up()
  await expect.poll(level, heard).toBe(0)
  const first = page.getByRole('button', { name: 'Synth, bar 1, step 1', exact: true })
  await expect(first).toHaveAttribute('aria-pressed', 'false')
})
