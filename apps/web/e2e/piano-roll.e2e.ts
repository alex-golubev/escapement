import { expect, type Page } from '@playwright/test'
import { keysWidth, stepWidth } from '../src/ui/views/piano-roll/layout'
import {
  addTrack,
  drawnAt,
  heard,
  listening,
  newClip,
  newProject,
  noteDrawn,
  pixelAt,
  playheadAt,
  pressPlay,
  rollAt,
  sounds,
  test
} from './page'

/** The steps of a bar. */
const barSteps = 16

/** A new project with a synth's track added, and a new clip of it, its notes below. */
const synthRoll = async (page: Page) => {
  await newProject(page)
  await addTrack(page, 'Synth')
  await newClip(page, 0, 0, 'Synth')
}

test('a melody put into the piano roll is erased in part, Cmd+Z brings some back, and what is left plays on the synth', async ({
  page
}) => {
  await synthRoll(page)
  // Whole, at the tests' 1280 by 720, under the Arrangement, which stays whole too.
  await expect(page.getByRole('region', { name: 'Synth, notes', exact: true })).toBeInViewport({ ratio: 1 })
  await expect(page.getByRole('region', { name: 'Arrangement', exact: true })).toBeInViewport({ ratio: 1 })
  const at = await rollAt(page)
  const clicked = async (step: number, key: number, button: 'left' | 'right' = 'left') => {
    const { x, y } = at(step, key)
    await page.mouse.click(x, y, { button })
  }
  const drawn = (step: number, key: number) => expect.poll(() => noteDrawn(page, at(step, key)))
  // C3, then E3 twice and G3.
  await clicked(0, 60)
  await clicked(4, 64)
  await clicked(6, 64)
  await clicked(8, 67)
  await drawn(8, 67).toBe(true)

  // A drag with the right button along E3 takes both; a right click, G3.
  const from = at(4, 64)
  const to = at(6, 64)
  await page.mouse.move(from.x, from.y)
  await page.mouse.down({ button: 'right' })
  await page.mouse.move(to.x, to.y, { steps: 4 })
  await page.mouse.up({ button: 'right' })
  await clicked(8, 67, 'right')
  await drawn(4, 64).toBe(false)
  await drawn(8, 67).toBe(false)
  await drawn(0, 60).toBe(true)
  await page.keyboard.press('ControlOrMeta+z')
  await drawn(8, 67).toBe(true)

  // What is left, C3 and G3, heard in the Mixer.
  await listening(page)
  await pressPlay(page, true)
  await sounds(page)
  await pressPlay(page, false)
  await expect(page.locator('.transport').getByRole('status')).toHaveText('')
})

test('a note dragged in the piano roll moves, its right edge stretches it, each written once let go as one step of undo', async ({
  page
}) => {
  await synthRoll(page)
  const at = await rollAt(page)
  const drawn = (step: number, key: number) => expect.poll(() => noteDrawn(page, at(step, key)))
  const c5 = at(0, 60)
  await page.mouse.click(c5.x, c5.y)
  await drawn(0, 60).toBe(true)

  // Up to E3 three steps on: drawn there at once, written only once let go.
  const e5 = at(3, 64)
  await page.mouse.move(c5.x, c5.y)
  await page.mouse.down()
  await page.mouse.move(e5.x, e5.y, { steps: 6 })
  await drawn(3, 64).toBe(true)
  await drawn(0, 60).toBe(false)
  await page.mouse.up()

  // By the last pixels of its step, two steps longer.
  const edge = { x: e5.x + stepWidth / 2 - 2, y: e5.y }
  await page.mouse.move(edge.x, edge.y)
  await expect(page.locator('.roll')).toHaveAttribute('data-grab', 'stretch')
  await page.mouse.down()
  await page.mouse.move(edge.x + 2 * stepWidth, edge.y, { steps: 6 })
  await page.mouse.up()
  await drawn(5, 64).toBe(true)
  await drawn(6, 64).toBe(false)

  await page.keyboard.press('ControlOrMeta+z')
  await drawn(5, 64).toBe(false)
  await drawn(3, 64).toBe(true)
  await page.keyboard.press('ControlOrMeta+z')
  await drawn(3, 64).toBe(false)
  await drawn(0, 60).toBe(true)
})

test('a note dragged into the second bar makes a clip of two bars, which plays whole, round and round', async ({
  page
}) => {
  await synthRoll(page)
  const at = await rollAt(page)
  const c5 = at(0, 60)
  const e5 = at(8, 64)
  await page.mouse.click(c5.x, c5.y)
  await page.mouse.click(e5.x, e5.y)
  await expect.poll(() => drawnAt(page, [[1, 0]])).toEqual([false])
  const later = at(8 + barSteps, 64)
  await page.mouse.move(e5.x, e5.y)
  await page.mouse.down()
  await page.mouse.move(later.x, later.y, { steps: 10 })
  await page.mouse.up()
  // The clip as long as its notes reach now.
  await expect.poll(() => drawnAt(page, [[1, 0]])).toEqual([true])
  await pressPlay(page, true)
  // Into the second bar, then round from the start; heard in the Mixer, in place of the Arrangement.
  await expect.poll(() => playheadAt(page), heard).toBeGreaterThan(1.2)
  await expect.poll(() => playheadAt(page), heard).toBeLessThan(0.4)
  await listening(page)
  await sounds(page)
  await pressPlay(page, false)
})

test('a roll two bars wide shows the second past the pattern until a note goes into it, already while it is held', async ({
  page
}) => {
  await synthRoll(page)
  // As wide as the page at 1280: more than two bars.
  expect((await page.locator('.roll').boundingBox())?.width).toBeGreaterThan(keysWidth + 2 * barSteps * stepWidth)
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

test('a melody of four bars, put as the roll scrolls across, plays whole, the roll going with the playhead', async ({
  page
}) => {
  await synthRoll(page)
  const at = await rollAt(page)
  const box = await page.locator('.roll').boundingBox()
  const bar = barSteps * stepWidth
  /** The key's row at the start of the bar, the roll scrolled as far as a pattern so many bars long lets it. */
  const atEnd = (bars: number, from: number, key: number) => {
    const left = Math.max(keysWidth + (bars + 1) * bar - (box?.width ?? 0), 0)
    return { x: (box?.x ?? 0) + keysWidth + from * bar - left + stepWidth / 2, y: at(0, key).y }
  }
  const put = async (bars: number, key: number) => {
    const { x, y } = atEnd(bars, bars, key)
    await page.mouse.click(x, y)
  }
  const c5 = at(0, 60)
  await page.mouse.click(c5.x, c5.y)
  // A bar on each time, in the bar past the pattern, scrolled to the end as it grows: by Shift and the wheel, then
  // sideways, as a swipe.
  await page.keyboard.down('Shift')
  await page.mouse.wheel(0, 4 * bar)
  await page.keyboard.up('Shift')
  await put(1, 62)
  await page.mouse.wheel(4 * bar, 0)
  await put(2, 64)
  await page.mouse.wheel(4 * bar, 0)
  await put(3, 67)
  const drawnAtKey = (key: number) => expect.poll(() => noteDrawn(page, at(0, key)), heard)
  // Back to the first bar, then played: the roll goes to the third bar as the playhead leaves it in sight, and round.
  await page.mouse.wheel(-4 * bar, 0)
  await drawnAtKey(60).toBe(true)
  await drawnAtKey(64).toBe(false)
  await pressPlay(page, true)
  await drawnAtKey(64).toBe(true)
  await expect.poll(() => playheadAt(page), heard).toBeGreaterThan(3)
  await drawnAtKey(60).toBe(true)
  await pressPlay(page, false)
})

test('a key of the piano roll pressed sounds on the synth while held, falls silent once let go of, and puts no note', async ({
  page
}) => {
  await synthRoll(page)
  // The Mixer in the middle, the notes under it.
  await listening(page)
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
  await expect.poll(() => noteDrawn(page, at(0, 60))).toBe(false)
})
