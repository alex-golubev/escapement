import { expect, type Locator, type Page } from '@playwright/test'
import { trackColours } from '@escapement/model'
import {
  addTrack,
  arrangementAt,
  arrangementLayout,
  below,
  clipPixel,
  drawnAt,
  nameOf,
  newClip,
  newProject,
  reload,
  rgbOf,
  test,
  tokenOf
} from './page'

const heads = (page: Page) => page.locator('.track-head__name')

/** Right-clicked at the middle of the control; where, for the menu to open there. */
const rightClick = async (page: Page, control: Locator) => {
  const box = await control.boundingBox()
  const at = { x: (box?.x ?? 0) + (box?.width ?? 0) / 2, y: (box?.y ?? 0) + (box?.height ?? 0) / 2 }
  await page.mouse.click(at.x, at.y, { button: 'right' })
  return at
}

const chosen = async (page: Page, track: string, item: string) => {
  await rightClick(page, nameOf(page, track))
  await page.getByRole('menu', { name: track, exact: true }).getByRole('menuitem', { name: item, exact: true }).click()
}

/** A new project with three synths' tracks. */
const threeTracks = async (page: Page) => {
  await newProject(page)
  await addTrack(page, 'Synth')
  await addTrack(page, 'Synth 2')
  await addTrack(page, 'Synth 3')
}

test("a track's menu opens at the pointer in place of the browser's, or under its name from the keyboard", async ({
  page
}) => {
  await threeTracks(page)
  const synth = nameOf(page, 'Synth')
  await page.evaluate(() => {
    document.addEventListener('contextmenu', (event) => {
      document.body.dataset.browsersMenu = String(!event.defaultPrevented)
    })
  })
  const menu = page.getByRole('menu', { name: 'Synth', exact: true })
  const at = await rightClick(page, synth)
  await expect(menu).toBeVisible()
  await expect(page.locator('body')).toHaveAttribute('data-browsers-menu', 'false')
  const opened = await menu.boundingBox()
  // The click's point as the page has it, in whole pixels.
  expect(Math.abs((opened?.x ?? 0) - at.x)).toBeLessThanOrEqual(1)
  expect(Math.abs((opened?.y ?? 0) - at.y)).toBeLessThanOrEqual(1)
  await expect(menu.getByRole('menuitem')).toHaveText(['Rename', 'Colour', 'Delete'])
  // A right click is no click: the track chosen, the last added, stays so, and the clips under the heads take nothing.
  await expect(below(page)).toHaveText('Synth 3|Track')
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()
  // Nor does it keep what it offered.
  await expect(page.locator('.menu [role="menuitem"]')).toHaveCount(0)
  await rightClick(page, synth)
  await page.mouse.click(600, 600)
  await expect(menu).toBeHidden()

  await synth.focus()
  await synth.press('Shift+F10')
  await expect(menu).toBeVisible()
  const under = await synth.boundingBox()
  expect((await menu.boundingBox())?.y).toBeGreaterThan((under?.y ?? 0) + (under?.height ?? 0))
  const item = (name: string) => menu.getByRole('menuitem', { name, exact: true })
  await expect(item('Rename')).toBeFocused()
  const goes = [
    ['ArrowDown', 'Colour'],
    ['ArrowDown', 'Delete'],
    ['ArrowDown', 'Rename'],
    ['ArrowUp', 'Delete'],
    ['Home', 'Rename'],
    ['End', 'Delete']
  ] as const
  await goes.reduce(
    (before, [key, to]) =>
      before.then(async () => {
        await page.keyboard.press(key)
        await expect(item(to)).toBeFocused()
      }),
    Promise.resolve()
  )
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()
  await expect(synth).toBeFocused()
  await synth.press('Shift+F10')
  await page.keyboard.press('Tab')
  await expect(menu).toBeHidden()
  await expect(synth).toBeFocused()
  // The focus taken away otherwise, as another window takes it.
  await synth.press('Shift+F10')
  await nameOf(page, 'Synth 2').evaluate((name) => name.focus())
  await expect(menu).toBeHidden()
})

test("a track's colour from its menu, by the keyboard, colours its head and clips for good; two tracks' clips are two colours, whole heads two lines", async ({
  page
}) => {
  await threeTracks(page)
  await newClip(page, 0, 0, 'Synth')
  await newClip(page, 1, 1, 'Synth 2')
  const at = await arrangementAt(page)
  const { barWidth, trackHeight, clipInset, clipHead } = await arrangementLayout(page)
  const [teal, indigo, rust] = trackColours.map(({ colour }) => colour)
  const row = rgbOf(await tokenOf(page, '.arrangement', '--arrangement-row'))
  // In the clip's head, past its name: opaque, a share of its colour over the row's, to a unit or so.
  const headOf = (bar: number, place: number) => {
    const { x, y } = at(bar, place)
    return { x: x + barWidth / 2 - 4, y: y - trackHeight / 2 + clipInset + clipHead / 2 }
  }
  const clipIn = async (colour: string, bar: number, place: number) => {
    const [red = 0, green = 0, blue = 0, alpha = 0] = await clipPixel(page, headOf(bar, place))
    const mixed = rgbOf(colour).map((channel, i) => 0.4 * channel + 0.6 * (row[i] ?? 0))
    const off = Math.max(...[red, green, blue].map((channel, i) => Math.abs(channel - (mixed[i] ?? 0))))
    return { near: off <= 1.5, alpha }
  }
  const shown = { near: true, alpha: 255 }
  await expect.poll(() => clipIn(teal, 0, 0)).toEqual(shown)
  expect(await clipIn(indigo, 1, 1)).toEqual(shown)
  const synth = nameOf(page, 'Synth')
  await synth.focus()
  await synth.press('Shift+F10')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  const colours = page.getByRole('menu', { name: 'Synth: colour', exact: true })
  await expect(colours.getByRole('menuitemradio')).toHaveText(trackColours.map(({ name }) => name))
  await expect(colours.getByRole('menuitemradio', { name: 'Teal', exact: true })).toBeFocused()
  await expect(colours.getByRole('menuitemradio', { checked: true })).toHaveText(['Teal'])
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(colours).toBeHidden()
  await expect(synth).toBeFocused()
  await expect.poll(() => clipIn(rust, 0, 0)).toEqual(shown)
  await reload(page)
  await expect.poll(() => clipIn(rust, 0, 0)).toEqual(shown)
  await expect(page.locator('.track-head').first()).toHaveCSS('--track-colour', rust)
  // At the tests' 1280 by 720: each head's two lines whole inside it.
  const cut = await page.locator('.track-head:not(.track-head--add)').evaluateAll(
    (heads) =>
      heads.filter((head) => {
        const box = head.getBoundingClientRect()
        return Array.from(head.children).some((line) => line.getBoundingClientRect().bottom > box.bottom)
      }).length
  )
  expect(cut).toBe(0)
})

test('a track renamed in place takes the name in its head, the panel and its knobs, over its notes too; Esc and undo leave the old', async ({
  page
}) => {
  await newProject(page)
  await addTrack(page, 'Synth')
  await newClip(page, 0, 0, 'Synth')
  await nameOf(page, 'Synth').click()
  await chosen(page, 'Synth', 'Rename')
  const field = page.getByRole('textbox', { name: 'Name of track 1', exact: true })
  await expect(field).toBeFocused()
  await expect(field).toHaveValue('Synth')
  // Typed over the old name, chosen whole.
  await page.keyboard.type('  Lead ')
  await page.keyboard.press('Enter')
  const renamed = nameOf(page, 'Lead')
  await expect(renamed).toBeFocused()
  await expect(below(page)).toHaveText('Lead|Track')
  await expect(page.getByRole('slider', { name: 'Lead: pan', exact: true }).first()).toBeVisible()
  const clip = (await arrangementAt(page))(0, 0)
  await page.mouse.dblclick(clip.x, clip.y)
  await expect(below(page)).toHaveText('Lead|Notes')

  await renamed.press('F2')
  await expect(field).toBeFocused()
  await page.keyboard.type('Other')
  await page.keyboard.press('Escape')
  await expect(renamed).toBeFocused()

  await page.keyboard.press('ControlOrMeta+z')
  await expect(nameOf(page, 'Synth')).toBeVisible()
  await expect(below(page)).toHaveText('Synth|Notes')
})

test('a track deleted takes its head, its clips and its place in the panel, the focus going to the next; undo brings them back', async ({
  page
}) => {
  await threeTracks(page)
  await newClip(page, 0, 1, 'Synth 2')
  await nameOf(page, 'Synth 2').click()
  await expect(below(page)).toHaveText('Synth 2|Track')
  await chosen(page, 'Synth 2', 'Delete')
  await expect(heads(page)).toHaveText(['Synth', 'Synth 3'])
  await expect(below(page)).toHaveText('')
  await expect(nameOf(page, 'Synth 3')).toBeFocused()
  // Its clip gone with it.
  await expect.poll(() => drawnAt(page, [[0, 1]])).toEqual([false])

  await page.keyboard.press('ControlOrMeta+z')
  await expect(heads(page)).toHaveText(['Synth', 'Synth 2', 'Synth 3'])
  await expect(below(page)).toHaveText('Synth 2|Track')
  await expect.poll(() => drawnAt(page, [[0, 1]])).toEqual([true])

  // A head going otherwise, here a track added and taken back, gives the focus on as well.
  await addTrack(page, 'Synth 4')
  await nameOf(page, 'Synth 4').focus()
  await page.keyboard.press('ControlOrMeta+z')
  await expect(heads(page)).toHaveText(['Synth', 'Synth 2', 'Synth 3'])
  await expect(nameOf(page, 'Synth 3')).toBeFocused()
})

test("by the page's edge a menu opens on the other side of the pointer, stretched to a long name on one line", async ({
  page
}) => {
  await threeTracks(page)
  const long = 'A track with a name far too long for any menu'
  await nameOf(page, 'Synth 3').press('F2')
  await page.keyboard.type(long)
  await page.keyboard.press('Enter')
  const width = page.viewportSize()?.width ?? 0
  // At points a mouse can't reach on the name.
  const openAt = async (name: string, x: number) => {
    await nameOf(page, name).evaluate(
      (control, x) =>
        control.dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: 300 })
        ),
      x
    )
    const menu = page.getByRole('menu', { name, exact: true })
    await expect(menu).toBeVisible()
    return (await menu.boundingBox()) ?? { x: 0, y: 0, width: 0, height: 0 }
  }
  const short = await openAt('Synth', width - 5)
  expect(short.x + short.width).toBeCloseTo(width - 5, 0)
  await page.keyboard.press('Escape')
  // Last placed by the edge, it is measured all the same.
  const stretched = await openAt(long, width - 120)
  expect(stretched.x + stretched.width).toBeCloseTo(width - 120, 0)
  expect(stretched.width).toBeGreaterThan(2 * short.width)
  expect(stretched.height).toBe(short.height)
})
