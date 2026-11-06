import { expect, type Locator, type Page } from '@playwright/test'
import { newProject, test } from './page'

const picker = (page: Page, name: string) => page.getByRole('button', { name: `Pattern: ${name}`, exact: true })

/** The current pattern's menu, opened by a right click on its name. */
const menuOf = async (page: Page, name: string): Promise<Locator> => {
  await picker(page, name).click({ button: 'right' })
  const menu = page.getByRole('menu', { name, exact: true })
  await expect(menu).toBeVisible()
  return menu
}

const chosen = async (page: Page, name: string, item: string) =>
  (await menuOf(page, name)).getByRole('menuitem', { name: item, exact: true }).click()

const step = (page: Page, name: string) => page.getByRole('button', { name, exact: true })

test('the current pattern renamed in place from its menu or with F2; Esc leaves the name, and undo the old one', async ({
  page
}) => {
  await newProject(page)
  await chosen(page, 'Pattern 1', 'Rename')
  const field = page.getByRole('textbox', { name: 'Name of the current pattern', exact: true })
  await expect(field).toBeFocused()
  await expect(field).toHaveValue('Pattern 1')
  // Typed over the old name, chosen whole.
  await page.keyboard.type('  Intro ')
  await page.keyboard.press('Enter')
  await expect(picker(page, 'Intro')).toBeFocused()
  await expect(page.locator('.dock-tab__sub').first()).toHaveText('Intro')

  await picker(page, 'Intro').press('F2')
  await expect(field).toBeFocused()
  await page.keyboard.type('Other')
  await page.keyboard.press('Escape')
  await expect(picker(page, 'Intro')).toBeFocused()

  await page.keyboard.press('ControlOrMeta+z')
  await expect(picker(page, 'Pattern 1')).toBeVisible()
})

test('a pattern deleted from its menu makes the next one current; undo brings it back, current again; the last has no Delete', async ({
  page
}) => {
  await newProject(page)
  const only = await menuOf(page, 'Pattern 1')
  await expect(only.getByRole('menuitem')).toHaveText(['Rename', 'Clone'])
  await page.keyboard.press('Escape')
  const add = page.getByRole('button', { name: 'Add a pattern', exact: true })
  await add.click()
  await add.click()
  await picker(page, 'Pattern 3').click()
  await page
    .getByRole('menu', { name: 'Patterns', exact: true })
    .getByRole('menuitemradio', { name: 'Pattern 2' })
    .click()
  await step(page, 'Kick, bar 1, step 2').click()
  await expect(step(page, 'Kick, bar 1, step 2')).toHaveAttribute('aria-pressed', 'true')

  await chosen(page, 'Pattern 2', 'Delete')
  await expect(picker(page, 'Pattern 3')).toBeVisible()
  await expect(step(page, 'Kick, bar 1, step 2')).toHaveAttribute('aria-pressed', 'false')
  await picker(page, 'Pattern 3').click()
  await expect(page.getByRole('menu', { name: 'Patterns', exact: true }).getByRole('menuitemradio')).toHaveText([
    'Pattern 1',
    'Pattern 3'
  ])
  await page.keyboard.press('Escape')

  await page.keyboard.press('ControlOrMeta+z')
  await expect(picker(page, 'Pattern 2')).toBeVisible()
  await expect(step(page, 'Kick, bar 1, step 2')).toHaveAttribute('aria-pressed', 'true')
})
