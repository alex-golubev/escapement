import { expect, type Page } from '@playwright/test'
import { barWidth, namesWidth, rulerHeight } from '../src/ui/windows/arrangement/layout'
import { arrangementAt, heardOn, modeButton, newProject, panAll, switchOn, test } from './page'

// Past the bars in sight at the fastest tempo, within the test's 30 s.
const heard = { timeout: 10_000, polling: 'raf' } as const

/** Whether the Arrangement draws a clip at the point: its clips' canvas is clear elsewhere. */
const clipDrawn = (page: Page, { x, y }: { readonly x: number; readonly y: number }) =>
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

/**
 * Where the Arrangement draws its playhead, in bars from the first bar in sight, a little under the ruler; below 0
 * while it draws none.
 */
const playheadAt = (page: Page) =>
  page.evaluate(
    ([names, bar, ruler]) => {
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
      return (x / scale - names) / bar
    },
    [namesWidth, barWidth, rulerHeight] as const
  )

/** The clips drawn at each place, by bar and track's place, as the page shows them. */
const drawnAt = async (page: Page, places: ReadonlyArray<readonly [bar: number, place: number]>) => {
  const at = await arrangementAt(page)
  return Promise.all(places.map(([bar, place]) => clipDrawn(page, at(bar, place))))
}

test('a new project opens the Arrangement under the Channels window; clips put, dragged and erased stay after a reload, and Cmd+Z takes each back', async ({
  page
}) => {
  await newProject(page)
  const window = page.getByRole('region', { name: 'Arrangement', exact: true }).first()
  // Whole, at the tests' 1280 by 720, as wide as the desk.
  await expect(window).toBeInViewport({ ratio: 1 })
  const channels = await page.getByRole('region', { name: 'Channels', exact: true }).first().boundingBox()
  const arrangement = await window.boundingBox()
  expect(arrangement?.y).toBeGreaterThan((channels?.y ?? 0) + (channels?.height ?? 0))
  expect(arrangement?.width).toBeGreaterThan(1200)
  const at = await arrangementAt(page)
  const click = async (bar: number, place: number, button: 'left' | 'right' = 'left') => {
    const { x, y } = at(bar, place)
    await page.mouse.click(x, y, { button })
  }
  const drag = async (button: 'left' | 'right', from: readonly [number, number], to: readonly [number, number]) => {
    const start = at(...from)
    const end = at(...to)
    await page.mouse.move(start.x, start.y)
    await page.mouse.down({ button })
    await page.mouse.move(end.x, end.y, { steps: 6 })
    await page.mouse.up({ button })
  }

  await click(1, 0)
  await expect.poll(() => drawnAt(page, [[1, 0]])).toEqual([true])
  await drag('left', [1, 0], [3, 2])
  await expect
    .poll(() =>
      drawnAt(page, [
        [1, 0],
        [3, 2]
      ])
    )
    .toEqual([false, true])
  await click(0, 4)
  await click(0, 5)
  await click(0, 6)
  await drag('right', [0, 4], [0, 5])
  await click(0, 6, 'right')
  await expect
    .poll(() =>
      drawnAt(page, [
        [0, 4],
        [0, 5],
        [0, 6]
      ])
    )
    .toEqual([false, false, false])
  // The drag with the right button is one step, the click another.
  await page.keyboard.press('ControlOrMeta+z')
  await expect
    .poll(() =>
      drawnAt(page, [
        [0, 4],
        [0, 5],
        [0, 6]
      ])
    )
    .toEqual([false, false, true])
  await page.keyboard.press('ControlOrMeta+z')
  await expect
    .poll(() =>
      drawnAt(page, [
        [0, 4],
        [0, 5],
        [0, 6]
      ])
    )
    .toEqual([true, true, true])

  await page.reload()
  await expect(window).toBeInViewport({ ratio: 1 })
  await expect
    .poll(() =>
      drawnAt(page, [
        [1, 0],
        [3, 2],
        [0, 4],
        [0, 5],
        [0, 6]
      ])
    )
    .toEqual([false, true, true, true, true])
})

test('a press on a clip makes its pattern current, and a clip as long as its pattern', async ({ page }) => {
  await newProject(page)
  const at = await arrangementAt(page)
  const first = at(0, 0)
  await page.mouse.click(first.x, first.y)
  await page.getByRole('button', { name: 'Add a pattern', exact: true }).click()
  // A step in the second bar: Pattern 2 is two bars long, and so is its clip.
  await page.getByRole('button', { name: 'Kick, bar 2, step 1', exact: true }).click()
  const second = at(0, 1)
  await page.mouse.click(second.x, second.y)
  await expect
    .poll(() =>
      drawnAt(page, [
        [0, 1],
        [1, 1],
        [1, 0]
      ])
    )
    .toEqual([true, true, false])
  await page.mouse.click(first.x, first.y)
  await expect(page.getByRole('button', { name: 'Pattern: Pattern 1', exact: true })).toBeVisible()
})

/** The louder of the master's meters, as drawn now. */
const loudness = (page: Page) =>
  page.evaluate(() =>
    Math.max(
      ...Array.from(document.querySelectorAll<HTMLElement>('.strip--master .meter__fill'), (fill) =>
        Number(fill.style.getPropertyValue('--level'))
      )
    )
  )

test("a clip's right edge dragged out to three bars plays its pattern in each, and stays so after a reload", async ({
  page
}) => {
  await newProject(page)
  // A kick on the first step of the pattern's one bar.
  await switchOn(page, 'Kick, bar 1, step 1')
  const at = await arrangementAt(page)
  const first = at(0, 0)
  await page.mouse.click(first.x, first.y)
  await expect
    .poll(() =>
      drawnAt(page, [
        [0, 0],
        [1, 0]
      ])
    )
    .toEqual([true, false])
  // From just inside its end to just inside the third bar's.
  const edge = (bar: number) => first.x - barWidth / 2 + bar * barWidth - 3
  await page.mouse.move(edge(1), first.y)
  await page.mouse.down()
  await page.mouse.move(edge(3), first.y, { steps: 4 })
  await page.mouse.up()
  await expect
    .poll(() =>
      drawnAt(page, [
        [2, 0],
        [3, 0]
      ])
    )
    .toEqual([true, false])
  await page.keyboard.press('l')
  await expect(modeButton(page, 'Arrangement')).toHaveAttribute('aria-pressed', 'true')
  const play = page.getByRole('button', { name: 'Play', exact: true })
  await play.click()
  await expect(play).toHaveAttribute('aria-pressed', 'true')
  // The meters fall 20 dB in 1.7 s, two bars 47 dB at 120: as loud again early in the third bar only if the kick
  // sounds there.
  const often = { ...heard, intervals: [20] }
  await expect.poll(() => playheadAt(page), often).toBeGreaterThan(0.2)
  const struck = await loudness(page)
  expect(struck).toBeGreaterThan(0)
  await expect.poll(() => playheadAt(page), often).toBeGreaterThan(2.1)
  expect(await loudness(page)).toBeGreaterThan(struck / 4)
  await play.click()
  await expect(play).toHaveAttribute('aria-pressed', 'false')
  await page.reload()
  await expect
    .poll(() =>
      drawnAt(page, [
        [2, 0],
        [3, 0]
      ])
    )
    .toEqual([true, false])
})

test("a clip's left edge dragged in by a bar plays its pattern from the second bar", async ({ page }) => {
  await newProject(page)
  // The pattern's first bar heard on the left, its second on the right.
  await panAll(page, 'Kick', 'Home', '100% left')
  await panAll(page, 'Snare', 'End', '100% right')
  await switchOn(page, 'Kick, bar 1, step 1')
  await switchOn(page, 'Snare, bar 2, step 1')
  const at = await arrangementAt(page)
  const first = at(0, 0)
  await page.mouse.click(first.x, first.y)
  await expect
    .poll(() =>
      drawnAt(page, [
        [0, 0],
        [1, 0],
        [2, 0]
      ])
    )
    .toEqual([true, true, false])
  // From just inside its start to just inside the second bar.
  const start = first.x - barWidth / 2 + 3
  await page.mouse.move(start, first.y)
  await page.mouse.down()
  await page.mouse.move(start + barWidth, first.y, { steps: 4 })
  await page.mouse.up()
  await expect
    .poll(() =>
      drawnAt(page, [
        [0, 0],
        [1, 0]
      ])
    )
    .toEqual([false, true])
  await page.keyboard.press('l')
  await expect(modeButton(page, 'Arrangement')).toHaveAttribute('aria-pressed', 'true')
  const play = page.getByRole('button', { name: 'Play', exact: true })
  await play.click()
  await expect(play).toHaveAttribute('aria-pressed', 'true')
  await heardOn(page, { silent: [0], sounding: [1] })
  await play.click()
  await expect(play).toHaveAttribute('aria-pressed', 'false')
})

test('in Arrangement mode the playhead runs along the Arrangement, and the Arrangement goes with it past its right edge', async ({
  page
}) => {
  await newProject(page)
  // The fastest the engine plays, a bar in under half a second.
  const tempo = page.getByRole('spinbutton', { name: 'Tempo', exact: true })
  await tempo.focus()
  await page.keyboard.press('End')
  await expect(tempo).toHaveAttribute('aria-valuenow', '522')
  const box = await page.locator('.arrangement').boundingBox()
  const inSight = Math.floor(((box?.width ?? 0) - namesWidth) / barWidth)
  const at = await arrangementAt(page)
  const click = async (bar: number, place: number) => {
    const { x, y } = at(bar, place)
    await page.mouse.click(x, y)
  }
  // A clip at the start, one in the last bar in sight, and, scrolled as far as it, one in the last bar in sight again.
  await click(0, 1)
  await click(inSight - 1, 0)
  await page.mouse.wheel(10 ** 5, 0)
  await expect
    .poll(() =>
      drawnAt(page, [
        [0, 1],
        [inSight - 1, 0]
      ])
    )
    .toEqual([false, false])
  await click(inSight - 1, 0)
  await page.keyboard.press('l')
  await expect(modeButton(page, 'Arrangement')).toHaveAttribute('aria-pressed', 'true')
  const play = page.getByRole('button', { name: 'Play', exact: true })
  await play.click()
  await expect(play).toHaveAttribute('aria-pressed', 'true')
  // To the start as it comes to be heard, the playhead running along the bars in sight.
  await expect.poll(() => drawnAt(page, [[0, 1]]), heard).toEqual([true])
  await expect.poll(() => playheadAt(page), heard).toBeGreaterThan(inSight - 2)
  // Past the right edge, to the playhead's bar: the last clip at the end of the bars in sight, the playhead early in them
  // as it goes on running.
  await expect
    .poll(
      () =>
        drawnAt(page, [
          [0, 1],
          [inSight - 1, 0]
        ]),
      heard
    )
    .toEqual([false, true])
  const now = await playheadAt(page)
  expect(now).toBeGreaterThanOrEqual(0)
  expect(now).toBeLessThan(inSight / 2)
  await play.click()
  await expect(play).toHaveAttribute('aria-pressed', 'false')
})
