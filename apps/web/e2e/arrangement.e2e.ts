import { expect, type Page } from '@playwright/test'
import { barWidth, headsWidth } from '../src/ui/windows/arrangement/layout'
import {
  addTrack,
  arrangementAt,
  drawnAt,
  newClip,
  newProject,
  playheadAt,
  pressPlay,
  putNote,
  test,
  toggleWindow
} from './page'

// Past the bars in sight at the fastest tempo, within the test's 30 s.
const heard = { timeout: 10_000, polling: 'raf' } as const

/** A new project with synths' tracks, `count` of them: "Synth", then "Synth 2" and on. */
const synths = async (page: Page, count: number) => {
  await newProject(page)
  await ['Synth', ...Array.from({ length: count - 1 }, (_, i) => `Synth ${i + 2}`)].reduce(
    (before, name) => before.then(() => addTrack(page, name).then(() => {})),
    Promise.resolve()
  )
}

test('clips put by a double click, dragged and erased stay after a reload, and Cmd+Z takes each back', async ({
  page
}) => {
  await synths(page, 5)
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

  // A click alone puts none.
  await click(1, 0)
  await expect.poll(() => drawnAt(page, [[1, 0]])).toEqual([false])
  await newClip(page, 1, 0, 'Synth')
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
  await newClip(page, 0, 2, 'Synth 3')
  await newClip(page, 0, 3, 'Synth 4')
  await newClip(page, 0, 4, 'Synth 5')
  await drag('right', [0, 2], [0, 3])
  await click(0, 4, 'right')
  await expect
    .poll(() =>
      drawnAt(page, [
        [0, 2],
        [0, 3],
        [0, 4]
      ])
    )
    .toEqual([false, false, false])
  // The drag with the right button is one step, the click another.
  await page.keyboard.press('ControlOrMeta+z')
  await expect
    .poll(() =>
      drawnAt(page, [
        [0, 2],
        [0, 3],
        [0, 4]
      ])
    )
    .toEqual([false, false, true])
  await page.keyboard.press('ControlOrMeta+z')
  await expect
    .poll(() =>
      drawnAt(page, [
        [0, 2],
        [0, 3],
        [0, 4]
      ])
    )
    .toEqual([true, true, true])

  await page.reload()
  await expect(page.getByRole('region', { name: 'Arrangement', exact: true }).first()).toBeInViewport({ ratio: 1 })
  await expect
    .poll(() =>
      drawnAt(page, [
        [1, 0],
        [3, 2],
        [0, 2],
        [0, 3],
        [0, 4]
      ])
    )
    .toEqual([false, true, true, true, true])
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

test("a clip's right edge dragged out to three bars plays its notes in each, and stays so after a reload", async ({
  page
}) => {
  await synths(page, 1)
  // A note on the first step of its pattern's one bar.
  await newClip(page, 0, 0, 'Synth')
  await putNote(page, 0)
  const at = await arrangementAt(page)
  const first = at(0, 0)
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
  await toggleWindow(page, 'Mixer')
  await pressPlay(page, true)
  // The meters fall 20 dB in 1.7 s, two bars 47 dB at 120: as loud again early in the third bar only if the note
  // sounds there.
  const often = { ...heard, intervals: [20] }
  await expect.poll(() => playheadAt(page), often).toBeGreaterThan(0.2)
  const struck = await loudness(page)
  expect(struck).toBeGreaterThan(0)
  await expect.poll(() => playheadAt(page), often).toBeGreaterThan(2.1)
  expect(await loudness(page)).toBeGreaterThan(struck / 4)
  await pressPlay(page, false)
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

test('the playhead runs along the Arrangement, and the Arrangement goes with it past its right edge', async ({
  page
}) => {
  await synths(page, 2)
  // The fastest the engine plays, a bar in under half a second.
  const tempo = page.getByRole('spinbutton', { name: 'Tempo', exact: true })
  await tempo.focus()
  await page.keyboard.press('End')
  await expect(tempo).toHaveAttribute('aria-valuenow', '522')
  const box = await page.locator('.arrangement').boundingBox()
  const inSight = Math.floor(((box?.width ?? 0) - headsWidth) / barWidth)
  // A clip at the start, one in the last bar in sight, and, scrolled as far as it, one in the last bar in sight again.
  await newClip(page, 0, 1, 'Synth 2')
  await newClip(page, inSight - 1, 0, 'Synth')
  await page.mouse.move((box?.x ?? 0) + headsWidth + 10, (box?.y ?? 0) + 60)
  await page.mouse.wheel(10 ** 5, 0)
  await expect
    .poll(() =>
      drawnAt(page, [
        [0, 1],
        [inSight - 1, 0]
      ])
    )
    .toEqual([false, false])
  await newClip(page, inSight - 1, 0, 'Synth')
  await pressPlay(page, true)
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
  await pressPlay(page, false)
})
