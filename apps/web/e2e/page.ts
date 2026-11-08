import { test as base, expect, type Page } from '@playwright/test'
import { barWidth, headsWidth, rulerHeight, trackHeight } from '../src/ui/views/arrangement/layout'
import { keysWidth, rowHeight, rulerHeight as rollRulerHeight, stepWidth } from '../src/ui/views/piano-roll/layout'

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

/** A new project, opened: the Arrangement with + alone in it, the panel under it. */
export const newProject = async (page: Page) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'New project', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Add a track', exact: true })).toBeVisible()
}

/**
 * The page reloaded once what it wrote is in IndexedDB: a reload cuts short a write still going, and a read of every
 * store starts only after the writes before it end.
 */
export const reload = async (page: Page) => {
  await page.evaluate(async () => {
    const done = <A>(request: IDBRequest<A>) => {
      const answered = Promise.withResolvers<A>()
      request.onsuccess = () => answered.resolve(request.result)
      request.onerror = () => answered.reject(request.error)
      return answered.promise
    }
    const read = (db: IDBDatabase) => {
      const ended = Promise.withResolvers<void>()
      const transaction = db.transaction(Array.from(db.objectStoreNames), 'readonly')
      transaction.oncomplete = () => ended.resolve()
      transaction.onabort = () => ended.reject(transaction.error)
      return ended.promise.finally(() => db.close())
    }
    const opened = await Promise.all((await indexedDB.databases()).map(({ name = '' }) => done(indexedDB.open(name))))
    await Promise.all(opened.filter((db) => db.objectStoreNames.length > 0).map(read))
  })
  await page.reload()
}

/** The button of the track's name in its head. */
export const nameOf = (page: Page, name: string) => page.getByRole('button', { name, exact: true })

/** A track with a synth added with +, named `name` as + names it; its name's button, once its head is in sight. */
export const addTrack = async (page: Page, name: string) => {
  await page.getByRole('button', { name: 'Add a track', exact: true }).click()
  await expect(nameOf(page, name)).toBeVisible()
  return nameOf(page, name)
}

/** Where on the page the Arrangement has the middle of the track's row in the bar, scrolled to the first of both. */
export const arrangementAt = async (page: Page) => {
  const box = await page.locator('.arrangement').boundingBox()
  return (bar: number, place: number) => ({
    x: (box?.x ?? 0) + headsWidth + (bar + 0.5) * barWidth,
    y: (box?.y ?? 0) + rulerHeight + (place + 0.5) * trackHeight
  })
}

/** The line over the panel: the chosen track's name and what of it is shown, as `Synth|Notes`; empty for none. */
export const below = (page: Page) => page.locator('.panel__title')

/** The colour the roll's canvas, of the grid or of the notes, draws at the point. */
export const pixelAt = (page: Page, layer: 'grid' | 'notes', { x, y }: { readonly x: number; readonly y: number }) =>
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
export const noteDrawn = async (page: Page, point: { readonly x: number; readonly y: number }) =>
  ((await pixelAt(page, 'notes', point))[3] ?? 0) > 0

/**
 * A new clip put by a double click on the track's row from the bar, opened in the piano roll on the track: once the
 * roll, laid out anew for it, has drawn its grid, and so takes a press.
 */
export const newClip = async (page: Page, bar: number, place: number, track: string) => {
  const { x, y } = (await arrangementAt(page))(bar, place)
  await page.mouse.dblclick(x, y)
  await expect(below(page)).toHaveText(`${track}|Notes`)
  // Nor does the double click select a word of a name beside it.
  expect(await page.evaluate(() => getSelection()?.toString())).toBe('')
  await expect(page.locator('.roll')).toBeVisible()
  const middle = (await rollAt(page))(0, 60)
  await expect.poll(async () => (await pixelAt(page, 'grid', middle))[3] ?? 0).toBeGreaterThan(0)
}

/**
 * Where on the page the piano roll has the key's row at the step: it opens with no notes centred on middle C, the
 * middle of C3's row in the middle of the rows.
 */
export const rollAt = async (page: Page) => {
  const box = await page.locator('.roll').boundingBox()
  const left = box?.x ?? 0
  const top = box?.y ?? 0
  const middle = top + rollRulerHeight + ((box?.height ?? 0) - rollRulerHeight) / 2
  return (step: number, key: number) => ({
    x: left + keysWidth + (step + 0.5) * stepWidth,
    y: middle - (key - 60) * rowHeight
  })
}

/** A note a step long put by a click on the piano roll, at the step and key, once the roll draws it. */
export const putNote = async (page: Page, step: number, key = 60) => {
  const at = (await rollAt(page))(step, key)
  await page.mouse.click(at.x, at.y)
  await expect.poll(() => noteDrawn(page, at)).toBe(true)
}

/** What the middle shows turned to by its button on the transport bar: Arrange, Mix or Debug. */
export const showCentre = async (page: Page, name: string) => {
  const button = page.locator('.btn--centre', { hasText: name })
  await button.click()
  await expect(button).toHaveAttribute('aria-pressed', 'true')
}

/** For a poll of what moves as the arrangement plays: every 20 ms, as a poll a second lands on a loop's same places. */
export const heard: Parameters<typeof expect.poll>[1] = { timeout: 10_000, intervals: [20] }

/** Play pressed, to play or to stop. */
export const pressPlay = async (page: Page, playing: boolean) => {
  const play = page.getByRole('button', { name: 'Play', exact: true })
  await play.click()
  await expect(play).toHaveAttribute('aria-pressed', String(playing))
}

/** The master's meters by their side, 0 left and 1 right: those that must stay silent, and those one of which rises. */
export interface Heard {
  readonly silent: ReadonlyArray<number>
  readonly sounding: ReadonlyArray<number>
}

/**
 * Until the master's meters, in the Mixer, are as `sides` asks, checked at every frame: they are drawn by frames, a
 * note lasts a few. Well past a bar at the project's tempo, well within a test's 30 s.
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

/** The track's pan turned all the way to one side by its key, in its head. */
export const panAll = async (page: Page, track: string, key: 'Home' | 'End', text: string) => {
  const pan = page.getByRole('slider', { name: `${track}: pan`, exact: true })
  await pan.focus()
  await pan.press(key)
  await expect(pan).toHaveAttribute('aria-valuetext', text)
}

/** Whether the Arrangement draws a clip at the point: its clips' canvas is clear elsewhere. */
export const clipDrawn = (page: Page, { x, y }: { readonly x: number; readonly y: number }) =>
  page.evaluate(
    ([x, y]) => {
      const canvas = document.querySelectorAll<HTMLCanvasElement>('.arrangement canvas')[1]
      const box = canvas.getBoundingClientRect()
      const scale = canvas.width / box.width
      // Read from a copy, once: the browser warns of a canvas read again and again.
      const copy = document.createElement('canvas')
      copy.width = 1
      copy.height = 1
      const g = copy.getContext('2d')
      g?.drawImage(canvas, (x - box.left) * scale, (y - box.top) * scale, 1, 1, 0, 0, 1, 1)
      return (g?.getImageData(0, 0, 1, 1).data[3] ?? 0) > 0
    },
    [x, y] as const
  )

/** The clips drawn at each place, by bar and track's place, as the page shows them. */
export const drawnAt = async (page: Page, places: ReadonlyArray<readonly [bar: number, place: number]>) => {
  const at = await arrangementAt(page)
  return Promise.all(places.map(([bar, place]) => clipDrawn(page, at(bar, place))))
}

/**
 * Where the Arrangement draws its playhead, in bars from the first bar in sight, a little under the ruler; below 0
 * while it draws none.
 */
export const playheadAt = (page: Page) =>
  page.evaluate(
    ([heads, bar, ruler]) => {
      const canvas = document.querySelectorAll<HTMLCanvasElement>('.arrangement canvas')[3]
      const scale = canvas.width / canvas.getBoundingClientRect().width
      // Read from a copy, once: the browser warns of a canvas read again and again.
      const copy = document.createElement('canvas')
      copy.width = canvas.width
      copy.height = 1
      const g = copy.getContext('2d')
      g?.drawImage(canvas, 0, Math.round((ruler + 4) * scale), canvas.width, 1, 0, 0, canvas.width, 1)
      const row = g?.getImageData(0, 0, canvas.width, 1).data ?? new Uint8ClampedArray()
      const x = Array.from({ length: canvas.width }, (_, i) => row[i * 4 + 3] ?? 0).findIndex((alpha) => alpha > 0)
      return (x / scale - heads) / bar
    },
    [headsWidth, barWidth, rulerHeight] as const
  )

/** The Mixer in the middle, for its meters; the panel under it stays as it was. */
export const listening = async (page: Page) => {
  await showCentre(page, 'Mix')
  await expect(page.locator('.strip--master')).toBeVisible()
}

/** Until one of the master's meters rises, checked at every frame. */
export const sounds = (page: Page) => heardOn(page, { silent: [], sounding: [0, 1] })
