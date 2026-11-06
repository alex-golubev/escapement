import { test as base, expect, type Page } from '@playwright/test'
import { barWidth, namesWidth, rulerHeight, trackHeight } from '../src/ui/windows/arrangement/layout'

/** Fails any test the page throws or complains in; checked after a timeout too, so the report says what went wrong. */
export const test = base.extend<{ complaints: undefined }>({
  complaints: [
    async ({ page }, use) => {
      const thrown: Array<string> = []
      page.on('pageerror', (error) => thrown.push(`thrown: ${error.message}`))
      const logged: Array<{ readonly type: string; readonly text: string }> = []
      page.on('console', (message) => logged.push({ type: message.type(), text: message.text() }))
      await use(undefined)
      const complained = logged.filter(({ type }) => type === 'error' || type === 'warning')
      expect([...thrown, ...complained.map(({ type, text }) => `${type}: ${text}`)]).toEqual([])
    },
    { auto: true }
  ]
})

export const newProject = async (page: Page) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'New project', exact: true }).click()
}

/** The half of the play mode's switch that reads `name`. */
export const modeButton = (page: Page, name: 'Pattern' | 'Arrangement') =>
  page.getByRole('button', { name: `${name} mode`, exact: true })

/** Where on the page the Arrangement has the middle of the track's row in the bar, scrolled to the first of both. */
export const arrangementAt = async (page: Page) => {
  const box = await page.locator('.arrangement').boundingBox()
  return (bar: number, place: number) => ({
    x: (box?.x ?? 0) + namesWidth + (bar + 0.5) * barWidth,
    y: (box?.y ?? 0) + rulerHeight + (place + 0.5) * trackHeight
  })
}

/** The master's meters by their side, 0 left and 1 right: those that must stay silent, and those one of which rises. */
export interface Heard {
  readonly silent: ReadonlyArray<number>
  readonly sounding: ReadonlyArray<number>
}

/**
 * Until the master's meters are as `sides` asks, checked at every frame: they are drawn by frames, a step lasts a few.
 * Well past a bar at the project's tempo, well within a test's 30 s.
 */
export const heardOn = (page: Page, { silent, sounding }: Heard) =>
  page.waitForFunction(
    ({ silent, sounding }) => {
      const levels = Array.from(document.querySelectorAll<HTMLElement>('.strip--master .meter__fill'), (fill) =>
        Number(fill.style.getPropertyValue('--level'))
      )
      return silent.every((side) => levels[side] === 0) && sounding.some((side) => levels[side] > 0)
    },
    { silent, sounding },
    { timeout: 10_000, polling: 'raf' }
  )

/** The channel's pan turned all the way to one side by its key. */
export const panAll = async (page: Page, channel: string, key: 'Home' | 'End', text: string) => {
  const pan = page.getByRole('slider', { name: `${channel}: pan`, exact: true })
  await pan.focus()
  await pan.press(key)
  await expect(pan).toHaveAttribute('aria-valuetext', text)
}

/** The step switched on, from off. */
export const switchOn = async (page: Page, step: string) => {
  const cell = page.getByRole('button', { name: step, exact: true })
  await expect(cell).toHaveAttribute('aria-pressed', 'false')
  await cell.click()
  await expect(cell).toHaveAttribute('aria-pressed', 'true')
}
