import { expect, type Locator, type Page } from '@playwright/test'
import { newProject, test } from './page'

const nameOf = (page: Page, name: string) => page.getByRole('button', { name, exact: true })

const namesInChannels = (page: Page) => page.locator('.seq-row__name')

/** Right-clicked at the middle of the control; where, for the menu to open there. */
const rightClick = async (page: Page, control: Locator) => {
  const box = await control.boundingBox()
  const at = { x: (box?.x ?? 0) + (box?.width ?? 0) / 2, y: (box?.y ?? 0) + (box?.height ?? 0) / 2 }
  await page.mouse.click(at.x, at.y, { button: 'right' })
  return at
}

const chosen = async (page: Page, channel: string, item: string) => {
  await rightClick(page, nameOf(page, channel))
  await page
    .getByRole('menu', { name: channel, exact: true })
    .getByRole('menuitem', { name: item, exact: true })
    .click()
}

test("a channel's menu opens at the pointer in place of the browser's, or under its name from the keyboard", async ({
  page
}) => {
  await newProject(page)
  const kick = nameOf(page, 'Kick')
  // On the project's page, which New project loads anew.
  await expect(kick).toBeVisible()
  await page.evaluate(() => {
    document.addEventListener('contextmenu', (event) => {
      document.body.dataset.browsersMenu = String(!event.defaultPrevented)
    })
  })
  const menu = page.getByRole('menu', { name: 'Kick', exact: true })
  const at = await rightClick(page, kick)
  await expect(menu).toBeVisible()
  await expect(page.locator('body')).toHaveAttribute('data-browsers-menu', 'false')
  const opened = await menu.boundingBox()
  // The click's point as the page has it, in whole pixels.
  expect(Math.abs((opened?.x ?? 0) - at.x)).toBeLessThanOrEqual(1)
  expect(Math.abs((opened?.y ?? 0) - at.y)).toBeLessThanOrEqual(1)
  await expect(menu.getByRole('menuitem')).toHaveText(['Piano roll', 'Rename', 'Delete'])
  // An item of two words on one line, as high as one of one word.
  const heightOf = async (name: string) =>
    (await menu.getByRole('menuitem', { name, exact: true }).boundingBox())?.height
  expect(await heightOf('Piano roll')).toBe(await heightOf('Rename'))
  // A right click is no click: the channel's window stays shut.
  await expect(page.getByRole('region', { name: 'Kick', exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()
  // Nor does it keep what it offered.
  await expect(page.locator('.menu [role="menuitem"]')).toHaveCount(0)
  await rightClick(page, kick)
  await page.mouse.click(5, 300)
  await expect(menu).toBeHidden()

  await kick.focus()
  await kick.press('Shift+F10')
  await expect(menu).toBeVisible()
  const under = await kick.boundingBox()
  expect((await menu.boundingBox())?.y).toBeGreaterThan((under?.y ?? 0) + (under?.height ?? 0))
  const item = (name: string) => menu.getByRole('menuitem', { name, exact: true })
  await expect(item('Piano roll')).toBeFocused()
  const goes = [
    ['ArrowDown', 'Rename'],
    ['ArrowDown', 'Delete'],
    ['ArrowDown', 'Piano roll'],
    ['ArrowUp', 'Delete'],
    ['Home', 'Piano roll'],
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
  await expect(kick).toBeFocused()
  await kick.press('Shift+F10')
  await page.keyboard.press('Tab')
  await expect(menu).toBeHidden()
  await expect(kick).toBeFocused()
  // The focus taken away otherwise, as another window takes it.
  await kick.press('Shift+F10')
  await nameOf(page, 'Snare').evaluate((name) => name.focus())
  await expect(menu).toBeHidden()
})

test('a channel renamed in place takes the name in its row, its window and its knobs; Esc and undo leave the old', async ({
  page
}) => {
  await newProject(page)
  await nameOf(page, 'Kick').click()
  await chosen(page, 'Kick', 'Rename')
  const field = page.getByRole('textbox', { name: 'Name of channel 1', exact: true })
  await expect(field).toBeFocused()
  await expect(field).toHaveValue('Kick')
  // Typed over the old name, chosen whole.
  await page.keyboard.type('  Big kick ')
  await page.keyboard.press('Enter')
  const renamed = nameOf(page, 'Big kick')
  await expect(renamed).toBeFocused()
  // The dock's group and the window in it, both named by the channel.
  await expect(page.getByRole('region', { name: 'Big kick', exact: true }).first()).toBeVisible()
  await expect(page.getByRole('slider', { name: 'Big kick: pan', exact: true }).first()).toBeVisible()

  await renamed.press('F2')
  await expect(field).toBeFocused()
  await page.keyboard.type('Other')
  await page.keyboard.press('Escape')
  await expect(renamed).toBeFocused()

  await page.keyboard.press('ControlOrMeta+z')
  await expect(nameOf(page, 'Kick')).toBeVisible()
  await expect(page.getByRole('region', { name: 'Kick', exact: true }).first()).toBeVisible()
})

test('a channel deleted takes its row and window, the focus going to the next; undo brings it back with its steps', async ({
  page
}) => {
  await newProject(page)
  const step = page.getByRole('button', { name: 'Snare, bar 1, step 3', exact: true })
  await step.click()
  await nameOf(page, 'Snare').click()
  await expect(page.getByRole('region', { name: 'Snare', exact: true }).first()).toBeVisible()
  await chosen(page, 'Snare', 'Delete')
  await expect(namesInChannels(page)).toHaveText(['Kick', 'Closed hat', 'Clap'])
  await expect(page.getByRole('region', { name: 'Snare', exact: true })).toHaveCount(0)
  await expect(nameOf(page, 'Closed hat')).toBeFocused()

  await page.keyboard.press('ControlOrMeta+z')
  await expect(namesInChannels(page)).toHaveText(['Kick', 'Snare', 'Closed hat', 'Clap'])
  await expect(step).toHaveAttribute('aria-pressed', 'true')

  // A row going otherwise, here a channel added and taken back, gives the focus on as well.
  await page.getByRole('button', { name: 'Add a channel', exact: true }).click()
  await nameOf(page, 'Synth').focus()
  await page.keyboard.press('ControlOrMeta+z')
  await expect(namesInChannels(page)).toHaveText(['Kick', 'Snare', 'Closed hat', 'Clap'])
  await expect(nameOf(page, 'Clap')).toBeFocused()
})

test("by the page's edge a menu opens on the other side of the pointer, stretched to a long name on one line", async ({
  page
}) => {
  await newProject(page)
  const long = 'A channel with a name far too long for any menu'
  await nameOf(page, 'Clap').press('F2')
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
  const short = await openAt('Kick', width - 5)
  expect(short.x + short.width).toBeCloseTo(width - 5, 0)
  await page.keyboard.press('Escape')
  // Last placed by the edge, it is measured all the same.
  const stretched = await openAt(long, width - 120)
  expect(stretched.x + stretched.width).toBeCloseTo(width - 120, 0)
  expect(stretched.width).toBeGreaterThan(2 * short.width)
  expect(stretched.height).toBe(short.height)
})
