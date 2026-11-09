import { expect, type Page } from '@playwright/test'
import {
  addTrack,
  arrangementAt,
  below,
  type Heard,
  heardOn,
  listening,
  nameOf,
  newClip,
  newProject,
  panAll,
  pressPlay,
  putNote,
  showCentre,
  test
} from './page'

const anySide: Heard = { silent: [], sounding: [0, 1] }

/** Plays until the master's meters are as `sides` asks, and stops: heard in the Mixer, then the Arrangement again. */
const plays = async (page: Page, sides: Heard = anySide) => {
  await listening(page)
  await pressPlay(page, true)
  await heardOn(page, sides)
  await pressPlay(page, false)
  await expect(page.locator('.transport').getByRole('status')).toHaveText('')
  await showCentre(page, 'Arrange')
  await expect(page.locator('.strip--master')).toHaveCount(0)
}

test('a new project opens empty: + under no track in the Arrangement, nothing in the panel under it', async ({
  page
}) => {
  await newProject(page)
  await expect(page.locator('.track-head__name')).toHaveCount(0)
  // Whole, at the tests' 1280 by 720, as wide as the page, the panel whole under it.
  const arrangement = page.getByRole('region', { name: 'Arrangement', exact: true })
  await expect(arrangement).toBeInViewport({ ratio: 1 })
  expect((await arrangement.boundingBox())?.width).toBeGreaterThan(1200)
  // No Debug in a build for users.
  await expect(page.locator('.btn--chosen')).toHaveText(['Arrange', 'Mix'])
  const panel = page.getByRole('region', { name: 'Nothing chosen', exact: true })
  await expect(panel).toBeInViewport({ ratio: 1 })
  expect((await panel.boundingBox())?.y).toBeGreaterThan(
    ((await arrangement.boundingBox())?.y ?? 0) + ((await arrangement.boundingBox())?.height ?? 0)
  )
  await expect(panel).toHaveText("Click a track's name to see it here, double-click a clip for its notes")
  // The transport on one line above, the hint line under, both whole.
  const transport = page.locator('.transport')
  await expect(transport).toBeInViewport({ ratio: 1 })
  const middleOf = async (name: string) => {
    const box = await page.getByRole('button', { name, exact: true }).boundingBox()
    return (box?.y ?? 0) + (box?.height ?? 0) / 2
  }
  expect(Math.abs((await middleOf('Mix')) - (await middleOf('Play')))).toBeLessThanOrEqual(1)
  await expect(page.locator('.hint')).toBeInViewport({ ratio: 1 })
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

/** The synth's card below, its track shown there. */
const synthCard = (page: Page) =>
  page.getByRole('region', { name: 'Synth, track', exact: true }).getByRole('region', { name: 'Synth', exact: true })

test("a synth's track below shows its card whole, every control in sight, with nothing to scroll", async ({ page }) => {
  await newProject(page)
  await (await addTrack(page, 'Synth')).click()
  // As the window is in the tests, 1280×720, and the panel as a new project has it.
  const card = synthCard(page)
  await expect(card).toBeInViewport({ ratio: 1 })
  await expect(card.getByRole('slider')).toHaveCount(14)
  await expect(card.getByRole('radiogroup')).toHaveCount(3)
  await (await card.locator('[role="slider"], [role="radio"]').all()).reduce(
    (before, control) => before.then(() => expect(control).toBeInViewport({ ratio: 1 })),
    Promise.resolve()
  )
  const scrolls = await page
    .locator('.panel__body')
    .evaluate((body) => [body.scrollWidth - body.clientWidth, body.scrollHeight - body.clientHeight])
  expect(scrolls).toEqual([0, 0])
  // The Arrangement stays whole over it.
  await expect(page.getByRole('region', { name: 'Arrangement', exact: true })).toBeInViewport({ ratio: 1 })
})

test("a knob on a synth's card turns its sound: Delay at its longest keeps its short note silent, back at none it sounds", async ({
  page
}) => {
  await newProject(page)
  // Each track heard on a side of its own.
  await addTrack(page, 'Synth')
  await addTrack(page, 'Synth 2')
  await panAll(page, 'Synth', 'Home', '100% left')
  await panAll(page, 'Synth 2', 'End', '100% right')
  await newClip(page, 0, 0, 'Synth')
  await putNote(page, 0)
  await newClip(page, 0, 1, 'Synth 2')
  await putNote(page, 0)
  await nameOf(page, 'Synth').click()
  await expect(below(page)).toHaveText('Synth|Track')
  await listening(page)
  await pressPlay(page, true)
  await heardOn(page, { silent: [], sounding: [0] })
  const delay = synthCard(page)
    .getByRole('group', { name: 'Envelope', exact: true })
    .getByRole('slider', { name: 'Delay', exact: true })
  await delay.focus()
  await delay.press('End')
  await expect(delay).toHaveAttribute('aria-valuenow', '10')
  await heardOn(page, { silent: [0], sounding: [1] })
  await delay.press('Home')
  await expect(delay).toHaveAttribute('aria-valuenow', '0')
  await heardOn(page, { silent: [], sounding: [0] })
  await pressPlay(page, false)
})
