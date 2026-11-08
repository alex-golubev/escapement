import { expect, type Page } from '@playwright/test'
import { addTrack, heardOn, listening, nameOf, newClip, newProject, panAll, putNote, test } from './page'

/** The track sent into the mixer strip by its number, typed into its field below, the track shown there. */
const sendInto = async (page: Page, track: string, strip: number) => {
  await nameOf(page, track).click()
  const field = page.getByRole('spinbutton', { name: `${track}: mixer strip`, exact: true })
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

test('tracks sent into strips of their own sound through them: a strip muted or faded out is heard no more', async ({
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
  await sendInto(page, 'Synth', 1)
  await sendInto(page, 'Synth 2', 2)
  await listening(page)
  const play = page.getByRole('button', { name: 'Play', exact: true })
  await play.click()
  await heardOn(page, { silent: [], sounding: [0] })
  await heardOn(page, { silent: [], sounding: [1] })
  // Each strip's meters show what it passes on: its own track, on its side.
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
