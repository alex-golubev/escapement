import { expect, type Locator, type Page } from '@playwright/test'
import {
  addTrack,
  arrangementAt,
  below,
  type Heard,
  heard,
  heardOn,
  listening,
  nameOf,
  newClip,
  newProject,
  panAll,
  playheadAt,
  pressPlay,
  pressStop,
  putNote,
  reload,
  showCentre,
  test
} from './page'

const anySide: Heard = { silent: [], sounding: [0, 1] }

/** Plays until the master's meters are as `sides` asks, and stops: heard in the Mixer, then the Arrangement again. */
const plays = async (page: Page, sides: Heard = anySide) => {
  await listening(page)
  await pressPlay(page, true)
  await heardOn(page, sides)
  await pressStop(page)
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
  // The transport whole on one line above, nothing of it cut off; the hint line under, Arrange and Mix beside it.
  const transport = page.locator('.transport')
  await expect(transport).toBeInViewport({ ratio: 1 })
  expect(await transport.evaluate((bar) => bar.scrollWidth <= bar.clientWidth)).toBe(true)
  const middleOf = async (target: Locator) => {
    const box = await target.boundingBox()
    return (box?.y ?? 0) + (box?.height ?? 0) / 2
  }
  const line = await middleOf(page.getByRole('button', { name: 'Play', exact: true }))
  const middles = await Promise.all((await transport.locator(':scope > *').all()).map(middleOf))
  expect(middles.every((middle) => Math.abs(middle - line) <= 1)).toBe(true)
  await expect(page.locator('.hint')).toBeInViewport({ ratio: 1 })
  const [hint, mix] = await Promise.all(
    [page.locator('.hint'), page.getByRole('button', { name: 'Mix', exact: true })].map(middleOf)
  )
  expect(Math.abs(hint - mix)).toBeLessThanOrEqual(1)
})

/** The bar counter and the time as shown, and the counter's ticks from the start. */
const clockOf = async (page: Page) => {
  const position = (await page.getByRole('timer', { name: 'Position', exact: true }).textContent()) ?? ''
  const time = (await page.getByRole('timer', { name: 'Time', exact: true }).textContent()) ?? ''
  const [bar = 0, beat = 0, tick = 0] = position.replace('BAR', '').split('.').map(Number)
  return { shown: `${position} ${time}`, ticks: (bar - 1) * 3840 + (beat - 1) * 960 + tick }
}

/** The clock once it stands, read the same a fifth of a second apart: a stop is heard a little after the press. */
const standing = async (page: Page) => {
  const read = { last: await clockOf(page) }
  await expect
    .poll(async () => {
      const before = read.last.shown
      await page.waitForTimeout(200)
      read.last = await clockOf(page)
      return read.last.shown === before
    })
    .toBe(true)
  return read.last
}

test('Play pauses where it plays and plays on from there; To start goes back, playing on; Stop stops at the start', async ({
  page
}) => {
  await newProject(page)
  await addTrack(page, 'Synth')
  // Four bars long: at 120, round from its end no sooner than 8 s after the start.
  await newClip(page, 3, 0, 'Synth')
  await expect(page.getByRole('button', { name: 'Record', exact: true })).toBeDisabled()
  const ticks = async () => (await clockOf(page)).ticks
  await pressPlay(page, true)
  await expect.poll(ticks, heard).toBeGreaterThan(3840)
  await pressPlay(page, false)
  // Standing in the second bar, the playhead with it.
  const paused = await standing(page)
  expect(paused.ticks).toBeGreaterThan(3840)
  expect(paused.ticks).toBeLessThan(2 * 3840)
  await expect.poll(() => playheadAt(page)).toBeCloseTo(paused.ticks / 3840, 1)
  // On from there: a beat on, half a second at 120, sooner than from the start.
  await pressPlay(page, true)
  await expect.poll(ticks, { timeout: 1_500, intervals: [20] }).toBeGreaterThan(paused.ticks + 960)
  // Back to the first bar at once, playing on, well before the loop's end would take it there.
  await page.getByRole('button', { name: 'To start', exact: true }).click()
  await expect.poll(ticks, { timeout: 1_500, intervals: [20] }).toBeLessThan(3840)
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toHaveAttribute('aria-pressed', 'true')
  // Stopped at the start, the playhead there too.
  await pressStop(page)
  await expect.poll(async () => (await clockOf(page)).shown).toBe('BAR001.01.000 TIME00:00.000')
  await expect.poll(() => playheadAt(page)).toBeCloseTo(0, 1)
})

test("the transport's master lights as the arrangement plays, the Mixer away; DSP load shows while it plays, and switched off stays off", async ({
  page
}) => {
  // As many cores as measuring needs, whatever the machine the test runs on has.
  await page.addInitScript(() => Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 }))
  await newProject(page)
  await addTrack(page, 'Synth')
  await newClip(page, 0, 0, 'Synth')
  await putNote(page, 0)
  const load = page.getByRole('button', { name: 'DSP load', exact: true })
  const loadShown = load.locator('.dsp-load__value')
  await expect(loadShown).toHaveText('—')
  await pressPlay(page, true)
  await page.waitForFunction(
    () => document.querySelectorAll('.master__segment[data-on="true"]').length > 0,
    undefined,
    {
      timeout: 10_000,
      polling: 'raf'
    }
  )
  await expect(page.locator('.strip--master')).toHaveCount(0)
  // A burst a second, measured to a tenth.
  await expect(loadShown).toHaveText(/^\d+\.\d%$/, { timeout: 5_000 })
  await pressStop(page)
  await expect(loadShown).toHaveText('—')
  await load.click()
  await expect(load).toHaveAttribute('aria-pressed', 'false')
  await reload(page)
  await expect(page.getByRole('button', { name: 'DSP load', exact: true })).toHaveAttribute('aria-pressed', 'false')
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
  await pressStop(page)
})
