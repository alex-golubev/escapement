// @vitest-environment happy-dom

import { RegistryContext } from '@effect/atom-react'
import { IndexedDb } from '@effect/platform-browser'
import { type Id, newId, newWriter } from '@escapement/model'
import { DateTime, Duration, Effect, FiberSet, Layer, Option, type Scope } from 'effect'
import { KeyValueStore } from 'effect/persistence'
import { AtomRegistry } from 'effect/reactivity'
import { render } from 'preact'
import { afterEach, expect, test, vi } from 'vitest'
import { registryOptions } from '../../src/app/core'
import { openProjectList, projectListsLayer } from '../../src/browser/project-list'
import { makeProject, openProjectStorage, projectStoreLayer, storageOf } from '../../src/browser/project-store'
import { appBase, projectHref } from '../../src/services/address'
import { Page } from '../../src/services/page'
import { type ListedProject, listNew, newName, type ProjectList } from '../../src/services/project-list'
import { projectsOf } from '../../src/services/projects'
import { ViewStores } from '../../src/services/view-store'
import {
  doubleClickTime,
  ListUnavailableScreen,
  NotInBrowserScreen,
  openedText,
  ProjectsScreen
} from '../../src/ui/screens/projects/projects'
import { browserIndexedDb, freshBrowser, noIndexedDb, ownWrites } from '../indexed-db'

/** Past Preact's render. */
const drawn = Effect.sleep(Duration.millis(5))

/** Once `done` holds, as long as the browser's storage takes, within two seconds. */
const until = (done: () => boolean) => Effect.repeat(drawn, { until: done, times: 400 })

/** Shown again from the browser's cache, as after Back; or, not from the cache, as it first loads. */
const pageShow = (persisted: boolean) => Object.assign(new Event('pageshow'), { persisted })

/** The storage of projects this browser keeps, by name. */
const projectStorages = Effect.map(
  Effect.promise(() => indexedDB.databases()),
  (all) =>
    all.flatMap(({ name }) =>
      Option.toArray(Option.filter(Option.fromNullishOr(name), (name) => name.startsWith('escapement-project/')))
    )
)

/** The list, as long as the scope is open. */
const list = Effect.flatMap(openProjectList(browserIndexedDb), Effect.fromOption)

/** What `use` does with the list, opened for it, as another tab would. */
const inList = <A, E>(use: (list: ProjectList) => Effect.Effect<A, E>) =>
  Effect.scoped(Effect.flatMap(list, use)).pipe(Effect.orDie)

/** A project listed by a page of the list before the screen opens, as its ID. */
const listedId = Effect.suspend(() => {
  const id = newId()
  return Effect.as(
    inList((list) => listNew(list, id)),
    id
  )
})

/** As `listedId`, with its document made first, as the page makes it. */
const madeBefore = Effect.suspend(() => {
  const id = newId()
  return makeProject(storageOf(id), newWriter('test'), [], id).pipe(
    Effect.orDie,
    Effect.andThen(inList((list) => listNew(list, id))),
    Effect.as(id)
  )
})

const names = (all: ReadonlyArray<ListedProject>) => all.map(({ name }) => name)

/** Listed by a page of the list before the screen opens. */
const listedBefore = list.pipe(
  Effect.flatMap((list) => Effect.andThen(listNew(list, newId()), list.all)),
  Effect.scoped,
  Effect.orDie
)

const listedNow = Effect.scoped(Effect.flatMap(list, (list) => list.all)).pipe(Effect.orDie)

/** How the page finds the project's storage as it opens it. */
const loadedOf = (id: Id) =>
  Effect.scoped(Effect.map(openProjectStorage(storageOf(id), newWriter('test'), [], id), ({ loaded }) => loaded))

/** IndexedDB that refuses to open any database. */
const refusing = Layer.succeed(
  IndexedDb.IndexedDb,
  IndexedDb.make({
    indexedDB: {
      open: () => {
        throw new DOMException('', 'SecurityError')
      }
    } as unknown as IDBFactory,
    IDBKeyRange: globalThis.IDBKeyRange
  })
)

interface Screen {
  readonly target: HTMLElement
  readonly page: EventTarget
  /** The projects the screen went to, by New project or a click on a name. */
  readonly opened: ReadonlyArray<Id>
  /** For each click on the screen, whether the browser would go on to follow its link, if any. */
  readonly followed: ReadonlyArray<boolean>
  /** The browser's store of views, in memory. */
  readonly views: KeyValueStore.KeyValueStore
  readonly button: (text: string) => HTMLButtonElement | HTMLAnchorElement
}

const shown = (target: HTMLElement) => ({
  rows: [...target.querySelectorAll<HTMLAnchorElement>('a.projects__open')].map((row) => ({
    text: row.textContent,
    href: row.getAttribute('href')
  })),
  notes: [...target.querySelectorAll('.projects__note')].map((note) => note.textContent)
})

/** The names on the rows, as shown. */
const namesShown = (target: HTMLElement) =>
  [...target.querySelectorAll('.projects__name')].map((name) => name.textContent)

const byText = (target: HTMLElement) => (text: string) =>
  Option.getOrThrowWith(
    Option.fromNullishOr(
      [...target.querySelectorAll<HTMLButtonElement | HTMLAnchorElement>('.btn')].find(
        (button) => button.textContent === text
      )
    ),
    () => new Error(`No ${text}`)
  )

/** The first that `selector` finds in `target`. */
const one = <E extends Element = HTMLElement>(target: ParentNode, selector: string) =>
  Option.getOrThrowWith(Option.fromNullishOr(target.querySelector<E>(selector)), () => new Error(`No ${selector}`))

/** A press of the mouse's main button, as the `detail`th click in a row. */
const click = (element: Element, init: MouseEventInit = {}) =>
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, detail: 1, ...init }))

const doubleClick = (element: Element) => {
  click(element)
  click(element, { detail: 2 })
  element.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, button: 0, detail: 2 }))
}

const keyDown = (element: Element, key: string) =>
  element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))

/** The field the name is changed in. */
const field = (target: HTMLElement) => one<HTMLInputElement>(target, '.projects__field')

/** The screen as the page draws it, in a browser whose IndexedDB `indexedDb` has, until the scope closes. */
const screen = Effect.fnUntraced(function* (indexedDb: Layer.Layer<IndexedDb.IndexedDb> = browserIndexedDb) {
  const registry = yield* AtomRegistry.AtomRegistry
  const runFork = yield* FiberSet.makeRuntime()
  const page = new EventTarget()
  const opened: Array<Id> = []
  const followed: Array<boolean> = []
  const views = yield* Effect.provide(Effect.service(KeyValueStore.KeyValueStore), KeyValueStore.layerMemory)
  const projects = yield* projectsOf((id) => Effect.sync(() => void opened.push(id))).pipe(
    Effect.provide(
      Layer.mergeAll(
        projectListsLayer(indexedDb),
        projectStoreLayer,
        Layer.succeed(ViewStores, { open: Effect.succeedSome(views) }),
        Layer.succeed(Page, page)
      )
    )
  )
  const target = yield* Effect.acquireRelease(
    Effect.sync(() => {
      const target = document.body.appendChild(document.createElement('div'))
      // Last to hear a click: what the screen made of it is told, and the test's page goes nowhere.
      target.addEventListener('click', (event) => {
        followed.push(!event.defaultPrevented)
        event.preventDefault()
      })
      render(
        <RegistryContext.Provider value={registry}>
          <ProjectsScreen projects={projects} run={(effect) => void runFork(effect)} />
        </RegistryContext.Provider>,
        target
      )
      return target
    }),
    (target) =>
      Effect.sync(() => {
        render(null, target)
        target.remove()
      })
  )
  yield* drawn
  return { target, page, opened, followed, views, button: byText(target) } satisfies Screen
})

const run = (effect: Effect.Effect<void, never, AtomRegistry.AtomRegistry | Scope.Scope>) =>
  effect.pipe(
    Effect.scoped,
    Effect.provideService(AtomRegistry.AtomRegistry, AtomRegistry.make(registryOptions)),
    Effect.runPromise
  )

afterEach(ownWrites)

test('the screen lists the projects, the last opened first, each a link to its page', () =>
  run(
    Effect.gen(function* () {
      yield* freshBrowser
      yield* listedBefore
      // Opened later than the first.
      yield* Effect.sleep('2 millis')
      const listed = yield* listedBefore
      const { target } = yield* screen()
      expect(listed).toHaveLength(2)
      expect(DateTime.isGreaterThan(listed[0].opened, listed[1].opened)).toBe(true)
      expect(shown(target)).toEqual({
        rows: listed.map(({ id, name, opened }) => ({
          text: `${name}${openedText(opened)}`,
          href: projectHref(id)
        })),
        notes: []
      })
    })
  ))

test('with no projects, the screen says so; New project makes one, lists it and goes to its page', () =>
  run(
    Effect.gen(function* () {
      yield* freshBrowser
      const { target, opened, button } = yield* screen()
      expect(shown(target)).toEqual({ rows: [], notes: ['No projects in this browser yet.'] })
      button('New project').click()
      yield* until(() => opened.length > 0)
      expect(opened).toHaveLength(1)
      expect(opened).toEqual((yield* listedNow).map(({ id }) => id))
      // Made before its page opens it: the page only opens it.
      expect(yield* loadedOf(opened[0])).toBe('saved')
    })
  ))

test('New project pressed again while one is on its way makes no other; back from the cache, it can be pressed', () =>
  run(
    Effect.gen(function* () {
      yield* freshBrowser
      const { page, opened, button } = yield* screen()
      button('New project').click()
      button('New project').click()
      yield* until(() => opened.length > 0)
      yield* drawn
      expect(button('New project')).toHaveProperty('disabled', true)
      expect(opened).toHaveLength(1)
      expect(yield* listedNow).toHaveLength(1)
      page.dispatchEvent(pageShow(true))
      yield* drawn
      expect(button('New project')).toHaveProperty('disabled', false)
    })
  ))

test("a page that stays, as going to the new project's was stopped, lists it and takes New project again", () =>
  run(
    Effect.gen(function* () {
      yield* freshBrowser
      const { target, opened, button } = yield* screen()
      button('New project').click()
      yield* until(() => opened.length > 0)
      expect(button('New project')).toHaveProperty('disabled', true)
      yield* until(() => !button('New project').matches(':disabled'))
      expect(button('New project')).toHaveProperty('disabled', false)
      expect(shown(target).rows.map(({ href }) => href)).toEqual([projectHref(opened[0])])
    })
  ))

test('shown again from the cache, as after Back, the screen reads the list again; first shown, it read it already', () =>
  run(
    Effect.gen(function* () {
      yield* freshBrowser
      const { target, page } = yield* screen()
      const [listed] = yield* listedBefore
      expect(shown(target).rows).toEqual([])
      page.dispatchEvent(pageShow(false))
      yield* drawn
      expect(shown(target).rows).toEqual([])
      page.dispatchEvent(pageShow(true))
      yield* drawn
      expect(shown(target).rows).toEqual([
        { text: `${listed.name}${openedText(listed.opened)}`, href: projectHref(listed.id) }
      ])
    })
  ))

test('a list that refuses the new project says so, erases what was made, and New project can be pressed again', () =>
  run(
    Effect.gen(function* () {
      yield* freshBrowser
      const { target, opened, button } = yield* screen()
      const before = yield* projectStorages
      IDBObjectStore.prototype.put = () => {
        throw new DOMException('', 'QuotaExceededError')
      }
      button('New project').click()
      yield* until(() => shown(target).notes.length > 1)
      expect(opened).toEqual([])
      // Its document, made first, is erased: no address leads to it.
      const left = yield* Effect.repeat(Effect.andThen(drawn, projectStorages), {
        until: (now) => now.length === before.length,
        times: 400
      })
      expect(left).toEqual(before)
      expect(shown(target).notes).toEqual([
        'No projects in this browser yet.',
        "The new project wasn't made: this browser's storage refused it."
      ])
      expect(button('New project')).toHaveProperty('disabled', false)
    })
  ))

test.each([
  ['refuses to open it', refusing],
  ['has no IndexedDB', noIndexedDb]
])("a list that doesn't open says so, and New project can't be pressed: a browser that %s", (_, indexedDb) =>
  run(
    Effect.gen(function* () {
      const { target, button } = yield* screen(indexedDb)
      expect(shown(target)).toEqual({
        rows: [],
        notes: ["The list of projects didn't load: this browser's storage refused or didn't answer."]
      })
      expect(button('New project')).toHaveProperty('disabled', true)
    })
  )
)

test('a double click on the name renames the project in place, a click elsewhere keeping the name; nothing opens', () =>
  run(
    Effect.gen(function* () {
      yield* freshBrowser
      yield* listedBefore
      const { target, opened, followed } = yield* screen()
      doubleClick(one(target, '.projects__name'))
      yield* drawn
      expect(field(target).value).toBe(newName)
      expect(document.activeElement).toBe(field(target))
      expect([field(target).selectionStart, field(target).selectionEnd]).toEqual([0, newName.length])
      field(target).value = '  Bassline  '
      field(target).blur()
      yield* until(() => namesShown(target)[0] === 'Bassline')
      expect(names(yield* listedNow)).toEqual(['Bassline'])
      yield* Effect.sleep(Duration.sum(Duration.fromInputUnsafe(doubleClickTime), Duration.millis(50)))
      expect(opened).toEqual([])
      // Neither click of the double one followed the link.
      expect(followed).toEqual([false, false])
    })
  ))

test('F2 renames too; Enter keeps the name and gives the row its focus back; Esc, and a name left empty, change nothing', () =>
  run(
    Effect.gen(function* () {
      yield* freshBrowser
      yield* listedBefore
      const { target } = yield* screen()
      const renamed = (name: string, key: string) =>
        Effect.gen(function* () {
          keyDown(one(target, '.projects__open'), 'F2')
          yield* drawn
          field(target).value = name
          keyDown(field(target), key)
          yield* drawn
          yield* until(() => target.querySelector('.projects__field') === null)
          expect(document.activeElement).toBe(one(target, '.projects__open'))
        })
      yield* renamed('Drums', 'Enter')
      yield* until(() => namesShown(target)[0] === 'Drums')
      yield* renamed('Other', 'Escape')
      // As in Chrome, the field loses the focus as it goes, after Esc: Preact hears that as focusout.
      keyDown(one(target, '.projects__open'), 'F2')
      yield* drawn
      field(target).value = 'Other'
      keyDown(field(target), 'Escape')
      field(target).dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
      yield* until(() => target.querySelector('.projects__field') === null)
      yield* renamed('   ', 'Enter')
      yield* drawn
      expect(namesShown(target)).toEqual(['Drums'])
      expect(names(yield* listedNow)).toEqual(['Drums'])
    })
  ))

test("a click on the name opens the project once a double click's time is over; one with Cmd, or off the name, goes at once", () =>
  run(
    Effect.gen(function* () {
      yield* freshBrowser
      const [listed] = yield* listedBefore
      const { target, opened, followed } = yield* screen()
      click(one(target, '.projects__name'))
      yield* drawn
      expect(opened).toEqual([])
      yield* until(() => opened.length > 0)
      expect(opened).toEqual([listed.id])
      click(one(target, '.projects__name'), { metaKey: true })
      click(one(target, '.projects__opened'))
      expect(followed).toEqual([false, true, true])
      yield* Effect.sleep(Duration.sum(Duration.fromInputUnsafe(doubleClickTime), Duration.millis(50)))
      expect(opened).toEqual([listed.id])
    })
  ))

test('the field stays while the window is away, as at another app, and while an input method picks a word', () =>
  run(
    Effect.gen(function* () {
      yield* freshBrowser
      yield* listedBefore
      const { target } = yield* screen()
      keyDown(one(target, '.projects__open'), 'F2')
      yield* drawn
      field(target).value = 'Bass'
      const away = vi.spyOn(document, 'hasFocus').mockReturnValue(false)
      field(target).dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
      away.mockRestore()
      field(target).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }))
      yield* drawn
      expect(field(target).value).toBe('Bass')
      expect(names(yield* listedNow)).toEqual([newName])
      field(target).value = 'Bassline'
      keyDown(field(target), 'Enter')
      yield* until(() => namesShown(target)[0] === 'Bassline')
    })
  ))

test('Delete gives the focus to the next row, or the one before', () =>
  run(
    Effect.gen(function* () {
      yield* freshBrowser
      const first = yield* listedId
      yield* Effect.sleep('2 millis')
      const second = yield* listedId
      const { target } = yield* screen()
      const deleting = (id: Id) =>
        Effect.gen(function* () {
          click(one(target, `a[href="${projectHref(id)}"] ~ .projects__delete`))
          yield* drawn
          byText(target)('Delete').click()
          yield* drawn
        })
      // The last opened first: `second` is on top.
      yield* deleting(second)
      expect(document.activeElement).toBe(one(target, `a[href="${projectHref(first)}"]`))
      yield* deleting(first)
      expect(document.activeElement).toBe(document.body)
    })
  ))

test('the bin asks first; Cancel and Esc keep the project; Delete takes it off the list, then erases its storage and layout', () =>
  run(
    Effect.gen(function* () {
      yield* freshBrowser
      const id = yield* madeBefore
      const { target, views } = yield* screen()
      yield* Effect.orDie(views.set(`layout:${id}`, '{}'))
      const asked = Effect.gen(function* () {
        click(one(target, '.projects__delete'))
        yield* drawn
        expect(one(target, '.projects__ask').textContent).toBe(`Delete “${newName}”? This can't be undone.`)
        expect(document.activeElement).toBe(byText(target)('Cancel'))
      })
      yield* asked
      byText(target)('Cancel').click()
      yield* drawn
      expect(document.activeElement).toBe(one(target, '.projects__open'))
      yield* asked
      keyDown(byText(target)('Cancel'), 'Escape')
      yield* drawn
      expect(namesShown(target)).toEqual([newName])
      yield* asked
      byText(target)('Delete').click()
      yield* drawn
      expect(shown(target)).toEqual({ rows: [], notes: ['No projects in this browser yet.'] })
      expect(yield* listedNow).toEqual([])
      yield* Effect.repeat(Effect.andThen(drawn, Effect.orDie(views.has(`layout:${id}`))), {
        until: (has) => !has,
        times: 400
      })
      expect(yield* projectStorages).not.toContain(storageOf(id))
      expect(yield* Effect.orDie(views.has(`layout:${id}`))).toBe(false)
    })
  ))

test('a name or a delete the list refuses is said so, and the project stays as it was', () =>
  run(
    Effect.gen(function* () {
      yield* freshBrowser
      yield* listedBefore
      const { target } = yield* screen()
      IDBObjectStore.prototype.put = () => {
        throw new DOMException('', 'QuotaExceededError')
      }
      keyDown(one(target, '.projects__open'), 'F2')
      yield* drawn
      field(target).value = 'Bassline'
      keyDown(field(target), 'Enter')
      // Shown at once, and back once the list is read again.
      yield* until(() => shown(target).notes.length > 0 && namesShown(target)[0] === newName)
      expect(shown(target).notes).toEqual(["The project wasn't renamed: this browser's storage refused it."])
      expect(namesShown(target)).toEqual([newName])
      ownWrites()
      IDBObjectStore.prototype.delete = () => {
        throw new DOMException('', 'InvalidStateError')
      }
      click(one(target, '.projects__delete'))
      yield* drawn
      byText(target)('Delete').click()
      yield* until(() => shown(target).notes[0] !== "The project wasn't renamed: this browser's storage refused it.")
      yield* until(() => namesShown(target).length > 0)
      expect(shown(target).notes).toEqual(["The project wasn't deleted: this browser's storage refused it."])
      expect(namesShown(target)).toEqual([newName])
    })
  ))

test('back to the tab, the screen reads the list again: another tab may have renamed or deleted a project', () =>
  run(
    Effect.gen(function* () {
      yield* freshBrowser
      const renamed = yield* listedId
      const deleted = yield* listedId
      const { target, page } = yield* screen()
      yield* inList((list) => Effect.andThen(list.change(renamed, { name: 'Bassline' }), list.remove(deleted)))
      expect(namesShown(target)).toEqual([newName, newName])
      page.dispatchEvent(new Event('focus'))
      yield* until(() => namesShown(target).length === 1)
      expect(namesShown(target)).toEqual(['Bassline'])
    })
  ))

test("a project's address this browser doesn't keep says so, with the way to the list; one that can't be told, with Reload", () => {
  const target = document.body.appendChild(document.createElement('div'))
  render(<NotInBrowserScreen />, target)
  expect(target.querySelector('h1')?.textContent).toBe("This project isn't in this browser")
  expect(byText(target)('Projects').getAttribute('href')).toBe(appBase)
  render(<ListUnavailableScreen />, target)
  expect(target.querySelector('h1')?.textContent).toBe("The project didn't open")
  // Not a link to the address: one with a # would only scroll.
  expect(byText(target)('Reload')).toBeInstanceOf(HTMLButtonElement)
  expect(byText(target)('Projects').getAttribute('href')).toBe(appBase)
  render(null, target)
  target.remove()
})
