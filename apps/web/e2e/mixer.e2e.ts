import { expect, type Page } from '@playwright/test'
import { heardOn, newProject, panAll, switchOn, test } from './page'

/** The channel sent into the mixer strip by its number, typed into its field. */
const sendInto = async (page: Page, channel: string, strip: number) => {
  const field = page.getByRole('spinbutton', { name: `${channel}: mixer strip`, exact: true })
  await field.focus()
  await field.press(String(strip))
  await field.press('Enter')
  await expect(field).toHaveAttribute('aria-valuetext', `strip ${strip}`)
}

/**
 * Until the strip's meters, found by its output's name, sound on exactly the sides `sounding` names, checked at every
 * frame.
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

test('channels sent into strips of their own sound through them: a strip muted or faded out is heard no more', async ({
  page
}) => {
  await newProject(page)
  // Each channel heard on a side of its own.
  await panAll(page, 'Kick', 'Home', '100% left')
  await panAll(page, 'Snare', 'End', '100% right')
  await sendInto(page, 'Kick', 1)
  await sendInto(page, 'Snare', 2)
  await switchOn(page, 'Kick, bar 1, step 1')
  await switchOn(page, 'Snare, bar 1, step 1')
  const play = page.getByRole('button', { name: 'Play', exact: true })
  await play.click()
  await heardOn(page, { silent: [], sounding: [0] })
  await heardOn(page, { silent: [], sounding: [1] })
  // Each strip's meters show what it passes on: its own channel, on its side.
  await stripSounds(page, 'Strip 1 output', [0])
  await stripSounds(page, 'Strip 2 output', [1])
  await stripSounds(page, 'Strip 3 output', [])
  await page.getByRole('button', { name: 'Strip 1: mute', exact: true }).click()
  await heardOn(page, { silent: [0], sounding: [1] })
  await stripSounds(page, 'Strip 1 output', [])
  const fader = page.getByRole('slider', { name: 'Strip 2: volume', exact: true })
  await fader.focus()
  await fader.press('Home')
  await expect(fader).toHaveAttribute('aria-valuetext', '−∞ dB')
  await page.getByRole('button', { name: 'Strip 1: mute', exact: true }).click()
  await heardOn(page, { silent: [1], sounding: [0] })
  await play.click()
})
