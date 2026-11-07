import { expect, type Page } from '@playwright/test'
import {
  addTrack,
  arrangementAt,
  type Heard,
  heardOn,
  newClip,
  newProject,
  panAll,
  pressPlay,
  putNote,
  test,
  toggleWindow
} from './page'

const anySide: Heard = { silent: [], sounding: [0, 1] }

/** Plays until the master's meters are as `sides` asks, and stops: the Mixer opened for them, and closed again. */
const plays = async (page: Page, sides: Heard = anySide) => {
  await toggleWindow(page, 'Mixer')
  await pressPlay(page, true)
  await heardOn(page, sides)
  await pressPlay(page, false)
  await expect(page.locator('.transport').getByRole('status')).toHaveText('')
  await toggleWindow(page, 'Mixer')
  await expect(page.locator('.strip--master')).toHaveCount(0)
}

test('a new project opens empty: the Arrangement alone, + under no track', async ({ page }) => {
  await newProject(page)
  await expect(page.locator('.dock-tab__title')).toHaveText(['Arrangement'])
  await expect(page.locator('.track-head__name')).toHaveCount(0)
  // Whole, at the tests' 1280 by 720, as wide as the desk.
  const window = page.getByRole('region', { name: 'Arrangement', exact: true }).first()
  await expect(window).toBeInViewport({ ratio: 1 })
  expect((await window.boundingBox())?.width).toBeGreaterThan(1200)
})

test('a track added with + plays the note put in its clip on its synth', async ({ page }) => {
  await newProject(page)
  await addTrack(page, 'Synth')
  await newClip(page, 0, 0, 'Synth')
  await putNote(page, 0)
  await plays(page)
})

test('a track panned all the way right is heard on the right only', async ({ page }) => {
  await newProject(page)
  await addTrack(page, 'Synth')
  await panAll(page, 'Synth', 'End', '100% right')
  await newClip(page, 0, 0, 'Synth')
  await putNote(page, 0)
  await plays(page, { silent: [0], sounding: [1] })
})

test("a clip plays on its track's instrument: moved to another track, it plays there", async ({ page }) => {
  await newProject(page)
  // Each track heard on a side of its own.
  await addTrack(page, 'Synth')
  await addTrack(page, 'Synth 2')
  await panAll(page, 'Synth', 'Home', '100% left')
  await panAll(page, 'Synth 2', 'End', '100% right')
  await newClip(page, 0, 0, 'Synth')
  await putNote(page, 0)
  await plays(page, { silent: [1], sounding: [0] })
  const at = await arrangementAt(page)
  const [from, to] = [at(0, 0), at(0, 1)]
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 6 })
  await page.mouse.up()
  await plays(page, { silent: [0], sounding: [1] })
})

test("a synth's window shows every control whole, opened right of the heads along the top", async ({ page }) => {
  await newProject(page)
  await (await addTrack(page, 'Synth')).click()
  // The window, named by the track, before the synth's own section in it, named by the plugin: both "Synth" here.
  const window = page.getByRole('region', { name: 'Synth', exact: true }).first()
  const controls = window.locator('[role="slider"], [role="radio"]')
  await expect(controls).not.toHaveCount(0)
  // Not cut off by the window's edge, nor by the page's: none needs scrolling to.
  await Promise.all((await controls.all()).map((control) => expect(control).toBeInViewport({ ratio: 1 })))
  // The heads stay in sight beside it.
  const heads = await page.locator('.track-heads').boundingBox()
  expect((await window.boundingBox())?.x).toBeGreaterThan((heads?.x ?? 0) + (heads?.width ?? 0))
})
