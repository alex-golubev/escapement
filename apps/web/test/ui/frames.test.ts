// @vitest-environment happy-dom
import { expect, test } from 'vitest'
import { setText } from '../../src/ui/parts/frames'

test("a text written on every frame goes into the element's own text, the page's tree unchanged", () => {
  const shown = document.createElement('span')
  shown.textContent = '001'
  document.body.append(shown)
  const text = shown.firstChild
  const changes = new MutationObserver(() => {})
  changes.observe(document.body, { subtree: true, childList: true })
  setText(shown, '002')
  setText(shown, '002')
  expect([shown.textContent, shown.firstChild === text, changes.takeRecords()]).toEqual(['002', true, []])
  changes.disconnect()
  // An empty one gets its text.
  const empty = document.createElement('span')
  setText(empty, '003')
  expect(empty.textContent).toBe('003')
  shown.remove()
})
