import { expect, type Page } from '@playwright/test'
import {
  addTrack,
  below,
  heardOn,
  listening,
  nameOf,
  newClip,
  newProject,
  panAll,
  putNote,
  showCentre,
  synths,
  test
} from './page'

/**
 * Until the strip's meters, found by its output's name, sound on exactly the sides `sounding` names, checked at every
 * frame: a meter falls to its floor in a few seconds.
 */
const stripSounds = (page: Page, output: string, sounding: ReadonlyArray<number>) =>
  page.waitForFunction(
    ({ output, sounding }) => {
      const fills = document.querySelectorAll<HTMLElement>(
        `.strip:has(button[aria-label="${output}: clip, left"]) .meter__fill`
      )
      const levels = Array.from(fills, (fill) => Number(fill.style.getPropertyValue('--level')))
      return levels.length === 2 && levels.every((level, side) => level > 0 === sounding.includes(side))
    },
    { output, sounding },
    { timeout: 10_000, polling: 'raf' }
  )

test("each track sounds through a strip of its own: its fader and M quiet it alone, and the fader is its head's volume", async ({
  page
}) => {
  await newProject(page)
  // Each track heard on a side of its own, a note in a clip of its own.
  await addTrack(page, 'Synth')
  await addTrack(page, 'Synth 2')
  await panAll(page, 'Synth', 'Home', '100% left')
  await panAll(page, 'Synth 2', 'End', '100% right')
  await newClip(page, 0, 0, 'Synth')
  await putNote(page, 0)
  await newClip(page, 0, 1, 'Synth 2')
  await putNote(page, 0)
  await listening(page)
  const play = page.getByRole('button', { name: 'Play', exact: true })
  await play.click()
  await heardOn(page, { silent: [], sounding: [0] })
  await heardOn(page, { silent: [], sounding: [1] })
  // Each strip's meters show what its track sounds, on its side.
  await stripSounds(page, 'Synth output', [0])
  await stripSounds(page, 'Synth 2 output', [1])
  await page.getByRole('button', { name: 'Synth: mute', exact: true }).click()
  await heardOn(page, { silent: [0], sounding: [1] })
  await stripSounds(page, 'Synth output', [])
  await stripSounds(page, 'Synth 2 output', [1])
  const fader = page.getByRole('slider', { name: 'Synth 2: volume', exact: true })
  await fader.focus()
  await fader.press('Home')
  await expect(fader).toHaveAttribute('aria-valuetext', '−∞ dB')
  await page.getByRole('button', { name: 'Synth: mute', exact: true }).click()
  await heardOn(page, { silent: [1], sounding: [0] })
  await stripSounds(page, 'Synth 2 output', [])
  await play.click()
  await showCentre(page, 'Arrange')
  await expect(page.getByRole('slider', { name: 'Synth 2: volume', exact: true })).toHaveAttribute(
    'aria-valuetext',
    '−∞ dB'
  )
})

test("the strips stand whole in the middle, the master right after them; a strip's name shows its track below, and a track deleted takes its strip, undo bringing it back", async ({
  page
}) => {
  await newProject(page)
  await addTrack(page, 'Synth')
  await addTrack(page, 'Synth 2')
  await addTrack(page, 'Synth 3')
  await showCentre(page, 'Mix')
  const names = page.locator('.strip__name')
  await expect(names).toHaveText(['Synth', 'Synth 2', 'Synth 3'])
  // As the window is in the tests, 1280×720, and the panel as a new project has it.
  const room = await page.locator('.workspace__centre').evaluate((centre) => ({
    scrolls: centre.scrollHeight > centre.clientHeight,
    bottom: centre.getBoundingClientRect().bottom
  }))
  const last = await page.locator('.rack .strip').last().boundingBox()
  const master = await page.locator('.strip--master').boundingBox()
  expect(room.scrolls).toBe(false)
  expect((last?.y ?? 0) + (last?.height ?? 0)).toBeLessThanOrEqual(room.bottom)
  expect((master?.x ?? 0) - ((last?.x ?? 0) + (last?.width ?? 0))).toBeGreaterThan(0)
  expect((master?.x ?? 0) - ((last?.x ?? 0) + (last?.width ?? 0))).toBeLessThan(20)

  await nameOf(page, 'Synth 2').click()
  await expect(below(page)).toHaveText('Synth 2|Track')
  await showCentre(page, 'Arrange')
  const head = await nameOf(page, 'Synth 2').boundingBox()
  await page.mouse.click((head?.x ?? 0) + 10, (head?.y ?? 0) + 5, { button: 'right' })
  await page
    .getByRole('menu', { name: 'Synth 2', exact: true })
    .getByRole('menuitem', { name: 'Delete', exact: true })
    .click()
  await showCentre(page, 'Mix')
  await expect(names).toHaveText(['Synth', 'Synth 3'])
  await page.keyboard.press('ControlOrMeta+z')
  await expect(names).toHaveText(['Synth', 'Synth 2', 'Synth 3'])
})

test('the rack draws only the strips in sight and one more each side; one scrolled back is drawn again, sounding', async ({
  page
}) => {
  // More strips than fit across, the first one sounding.
  await synths(page, 20)
  await newClip(page, 0, 0, 'Synth')
  await putNote(page, 0)
  await listening(page)
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  await stripSounds(page, 'Synth output', [0, 1])
  const rack = page.locator('.rack')
  // A strip and the gap after it, as the page lays them out.
  const [first, second] = await Promise.all([0, 1].map((i) => page.locator('.rack .strip').nth(i).boundingBox()))
  const step = (second?.x ?? 0) - (first?.x ?? 0)
  expect(step).toBeGreaterThan(0)
  const across = await rack.evaluate((shown, step) => Math.ceil(shown.clientWidth / step), step)
  expect(await page.locator('.rack .strip').count()).toBeLessThanOrEqual(across + 2)
  await rack.evaluate((shown) => {
    shown.scrollLeft = shown.scrollWidth
  })
  await expect(page.locator('.rack .strip__name').last()).toHaveText('Synth 20')
  await expect(page.locator('.strip:has(button[aria-label="Synth output: clip, left"])')).toHaveCount(0)
  expect(await page.locator('.rack .strip').count()).toBeLessThanOrEqual(across + 2)
  await rack.evaluate((shown) => {
    shown.scrollLeft = 0
  })
  await stripSounds(page, 'Synth output', [0, 1])
})

test('a rack scrolled further than its strips now go draws them all the same, its tracks taken away while it was away', async ({
  page
}) => {
  await synths(page, 20)
  await showCentre(page, 'Mix')
  await page.locator('.rack').evaluate((shown) => {
    shown.scrollLeft = shown.scrollWidth
  })
  await expect(page.locator('.rack .strip__name').last()).toHaveText('Synth 20')
  await showCentre(page, 'Arrange')
  await Array.from({ length: 16 }).reduce<Promise<void>>(
    (before) => before.then(() => page.keyboard.press('ControlOrMeta+z')),
    Promise.resolve()
  )
  await expect(page.locator('.track-head__name')).toHaveCount(4)
  // The browser can't scroll four strips as far as twenty.
  await showCentre(page, 'Mix')
  await expect(page.locator('.rack .strip__name')).toHaveText(['Synth', 'Synth 2', 'Synth 3', 'Synth 4'])
})
