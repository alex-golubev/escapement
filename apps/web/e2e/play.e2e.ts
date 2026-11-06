import { expect, type Page } from '@playwright/test'
import { arrangementAt, type Heard, heardOn, modeButton, newProject, panAll, switchOn, test } from './page'

// Well past a bar at the project's tempo, well within the test's 30 s.
const heard = { timeout: 10_000, polling: 'raf' } as const

const anySide: Heard = { silent: [], sounding: [0, 1] }

/** Play pressed, to play or to stop. */
const pressPlay = async (page: Page, playing: boolean) => {
  const play = page.getByRole('button', { name: 'Play', exact: true })
  await play.click()
  await expect(play).toHaveAttribute('aria-pressed', String(playing))
}

/** Switches the step on, then plays until the playhead has gone round and the master's meter has risen, and stops. */
const playsTheStep = async (page: Page, step: string, sides: Heard = anySide) => {
  await switchOn(page, step)
  await pressPlay(page, true)
  await page.waitForFunction(
    () => document.querySelector('[aria-label="Kick, bar 1, step 16"][data-now]') !== null,
    undefined,
    heard
  )
  await heardOn(page, sides)
  await pressPlay(page, false)
  await expect(page.locator('.transport').getByRole('status')).toHaveText('')
}

test('a new project plays the step switched on in it', async ({ page }) => {
  await newProject(page)
  await playsTheStep(page, 'Kick, bar 1, step 1')
})

test('channels added with + play their steps on the synth, the Channels window growing to show them', async ({
  page
}) => {
  await newProject(page)
  const add = page.getByRole('button', { name: 'Add a channel', exact: true })
  await add.click()
  await add.click()
  // The newest row seen whole, not cut off by the window's edge.
  await expect(page.getByRole('button', { name: 'Synth 2, bar 1, step 16', exact: true })).toBeInViewport({ ratio: 1 })
  await playsTheStep(page, 'Synth 2, bar 1, step 1')
})

test('a channel panned all the way right is heard on the right only', async ({ page }) => {
  await newProject(page)
  await panAll(page, 'Kick', 'End', '100% right')
  await playsTheStep(page, 'Kick, bar 1, step 1', { silent: [0], sounding: [1] })
})

test('a pattern added with + plays its own steps; the one chosen on the transport bar plays, chosen while playing too', async ({
  page
}) => {
  await newProject(page)
  // Each pattern heard on a side of its own.
  await panAll(page, 'Kick', 'Home', '100% left')
  await panAll(page, 'Snare', 'End', '100% right')
  await switchOn(page, 'Kick, bar 1, step 1')
  await page.getByRole('button', { name: 'Add a pattern', exact: true }).click()
  const picker = page.getByRole('button', { name: 'Pattern: Pattern 2', exact: true })
  await expect(picker).toBeVisible()
  await switchOn(page, 'Snare, bar 1, step 1')
  await pressPlay(page, true)
  await heardOn(page, { silent: [0], sounding: [1] })
  await picker.click()
  const patterns = page.getByRole('menu', { name: 'Patterns', exact: true })
  // Opened on the current one, as a list of choices opens.
  await expect(patterns.getByRole('menuitemradio', { name: 'Pattern 2' })).toBeFocused()
  await expect(patterns.getByRole('menuitemradio', { name: 'Pattern 2' })).toHaveAttribute('aria-checked', 'true')
  await patterns.getByRole('menuitemradio', { name: 'Pattern 1' }).click()
  await expect(page.getByRole('button', { name: 'Pattern: Pattern 1', exact: true })).toBeVisible()
  await heardOn(page, { silent: [1], sounding: [0] })
  await pressPlay(page, false)
  await expect(page.locator('.transport').getByRole('status')).toHaveText('')
})

/** The pattern made current from the list the transport bar's pattern opens. */
const choosePattern = async (page: Page, now: string, name: string) => {
  await page.getByRole('button', { name: `Pattern: ${now}`, exact: true }).click()
  await page
    .getByRole('menu', { name: 'Patterns', exact: true })
    .getByRole('menuitemradio', { name, exact: true })
    .click()
  await expect(page.getByRole('button', { name: `Pattern: ${name}`, exact: true })).toBeVisible()
}

test('in Arrangement mode Play plays the arrangement, clip by clip, and L back to Pattern mode plays the current pattern alone', async ({
  page
}) => {
  await newProject(page)
  // Pattern 1 heard on the left, Pattern 2 on the right.
  await panAll(page, 'Kick', 'Home', '100% left')
  await panAll(page, 'Snare', 'End', '100% right')
  await switchOn(page, 'Kick, bar 1, step 1')
  await page.getByRole('button', { name: 'Add a pattern', exact: true }).click()
  await switchOn(page, 'Snare, bar 1, step 1')
  await choosePattern(page, 'Pattern 2', 'Pattern 1')
  const at = await arrangementAt(page)
  const first = at(0, 0)
  await page.mouse.click(first.x, first.y)
  await choosePattern(page, 'Pattern 1', 'Pattern 2')
  // The arrangement has only Pattern 1, though Pattern 2 is current.
  await modeButton(page, 'Arrangement').click()
  await expect(modeButton(page, 'Arrangement')).toHaveAttribute('aria-pressed', 'true')
  await pressPlay(page, true)
  await heardOn(page, { silent: [1], sounding: [0] })
  // Pattern 2 after it, on a track of its own: the arrangement plays both.
  const second = at(1, 1)
  await page.mouse.click(second.x, second.y)
  await heardOn(page, { silent: [], sounding: [1] })
  await page.keyboard.press('l')
  await expect(modeButton(page, 'Pattern')).toHaveAttribute('aria-pressed', 'true')
  await heardOn(page, { silent: [0], sounding: [1] })
  await pressPlay(page, false)
  await expect(page.locator('.transport').getByRole('status')).toHaveText('')
})

test('a pattern cloned plays as it does; a step put in the copy leaves the pattern as it sounded', async ({ page }) => {
  await newProject(page)
  // The pattern heard on the left, what the copy gains on the right.
  await panAll(page, 'Kick', 'Home', '100% left')
  await panAll(page, 'Snare', 'End', '100% right')
  await switchOn(page, 'Kick, bar 1, step 1')
  await page.getByRole('button', { name: 'Pattern: Pattern 1', exact: true }).click({ button: 'right' })
  await page
    .getByRole('menu', { name: 'Pattern 1', exact: true })
    .getByRole('menuitem', { name: 'Clone', exact: true })
    .click()
  const copy = page.getByRole('button', { name: 'Pattern: Pattern 1 #2', exact: true })
  await expect(copy).toBeVisible()
  await expect(page.getByRole('button', { name: 'Kick, bar 1, step 1', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await pressPlay(page, true)
  await heardOn(page, { silent: [1], sounding: [0] })
  await switchOn(page, 'Snare, bar 1, step 1')
  await heardOn(page, { silent: [], sounding: [1] })
  await copy.click()
  await page
    .getByRole('menu', { name: 'Patterns', exact: true })
    .getByRole('menuitemradio', { name: 'Pattern 1', exact: true })
    .click()
  await expect(page.getByRole('button', { name: 'Snare, bar 1, step 1', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false'
  )
  // The meters fall back as the snare's sound fades: the right goes silent again.
  await heardOn(page, { silent: [1], sounding: [0] })
  await pressPlay(page, false)
  await expect(page.locator('.transport').getByRole('status')).toHaveText('')
})

test("a synth's window shows every control whole, opened over the Mixer along the top", async ({ page }) => {
  await newProject(page)
  await page.getByRole('button', { name: 'Add a channel', exact: true }).click()
  await page.getByRole('button', { name: 'Synth', exact: true }).click()
  // The window, named by the channel, before the synth's own section in it, named by the plugin: both "Synth" here.
  const window = page.getByRole('region', { name: 'Synth', exact: true }).first()
  const controls = window.locator('[role="slider"], [role="radio"]')
  await expect(controls).not.toHaveCount(0)
  // Not cut off by the window's edge, nor by the page's: none needs scrolling to.
  await Promise.all((await controls.all()).map((control) => expect(control).toBeInViewport({ ratio: 1 })))
})
