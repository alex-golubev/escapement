import { Array, Boolean, Data, Number, Option } from 'effect'
import { Check, ChevronRight } from 'lucide-preact'
import {
  type ComponentChildren,
  createContext,
  type TargetedFocusEvent,
  type TargetedKeyboardEvent,
  type TargetedMouseEvent
} from 'preact'
import { useContext, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks'
import { pixelsOf } from './pixels'
import { remOf } from './rem'
import './menu.css'

interface ItemFace {
  readonly label: string
  readonly icon: ComponentChildren
  readonly hint: string
}

/** What an item does as the menu closes, alone or as one of several, one checked; or opens its menu in this one's place. */
export type MenuItem = Data.TaggedEnum<{
  Action: ItemFace & { readonly chosen: () => void }
  Choice: ItemFace & { readonly chosen: () => void; readonly checked: boolean }
  Next: ItemFace & { readonly menu: () => Menu }
}>

export const MenuItem = Data.taggedEnum<MenuItem>()

/** What a control offers on a right click, under the name of what it acts on. */
export interface Menu {
  readonly title: string
  readonly items: ReadonlyArray<MenuItem>
}

/** At the pointer, as a right click opens it; under a control, as a key does, its first item focused. */
type MenuPlace = Data.TaggedEnum<{
  Pointer: { readonly x: number; readonly y: number }
  Under: { readonly control: Element }
}>

const MenuPlace = Data.taggedEnum<MenuPlace>()

interface Menus {
  readonly open: (menu: Menu, place: MenuPlace) => void
}

const MenusContext = createContext<Menus>({ open: () => {} })

/** As the browser opens its own on Windows and Linux. */
const asksForMenu = ({ key, shiftKey }: KeyboardEvent) => key === 'ContextMenu' || (shiftKey && key === 'F10')

/** What a control takes to open its menu in place of the browser's: with a right click, Shift+F10 or the menu key. */
export const useContextMenu = (menu: () => Menu) => {
  const menus = useContext(MenusContext)
  return {
    onContextMenu: (event: TargetedMouseEvent<Element>) => {
      event.preventDefault()
      menus.open(menu(), MenuPlace.Pointer({ x: event.clientX, y: event.clientY }))
    },
    onKeyDown: (event: TargetedKeyboardEvent<Element>) =>
      Option.match(Option.liftPredicate(event, asksForMenu), {
        onNone: () => {},
        onSome: ({ currentTarget }) => {
          event.preventDefault()
          menus.open(menu(), MenuPlace.Under({ control: currentTarget }))
        }
      })
  }
}

/** What a button takes to open its menu under it, as a click or its keys press it: a list to choose from. */
export const useMenuButton = (menu: () => Menu) => {
  const menus = useContext(MenusContext)
  return {
    'aria-haspopup': 'menu' as const,
    onClick: ({ currentTarget }: TargetedMouseEvent<Element>) =>
      menus.open(menu(), MenuPlace.Under({ control: currentTarget }))
  }
}

/** Off the page's edges, in rems: as the menu's widest leaves it. */
const margin = 0.25

/** Between a control and its menu, in rems. */
const gap = 0.125

/** Along one axis: after what it opens from, or, where that runs past `room`, ending before it; `margin` off the edges. */
export const startOf = (after: number, before: number, size: number, room: number, margin: number) =>
  Number.clamp(Boolean.match(after + size + margin <= room, { onTrue: () => after, onFalse: () => before - size }), {
    minimum: margin,
    maximum: Math.max(margin, room - size - margin)
  })

const fromOf = (place: MenuPlace, apart: number) =>
  MenuPlace.$match(place, {
    Pointer: ({ x, y }) => ({ left: x, right: x, top: y, bottom: y }),
    Under: ({ control }) => {
      const { left, right, top, bottom } = control.getBoundingClientRect()
      return { left, right, top: top - apart, bottom: bottom + apart }
    }
  })

const place = (menu: HTMLElement, at: MenuPlace) => {
  const rem = remOf()
  const from = fromOf(at, pixelsOf(rem, gap))
  const { width, height } = menu.getBoundingClientRect()
  const off = pixelsOf(rem, margin)
  menu.style.left = `${startOf(from.left, from.right, width, window.innerWidth, off)}px`
  menu.style.top = `${startOf(from.bottom, from.top, height, window.innerHeight, off)}px`
}

const itemsOf = (menu: HTMLElement) =>
  Array.fromIterable(menu.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"]'))

const focusAt = (items: ReadonlyArray<HTMLElement>, at: number) =>
  Option.map(Array.get(items, at), (item) => item.focus())

interface Shown {
  readonly menu: Menu
  readonly at: MenuPlace
  /** Whether its first item takes the focus: opened by a key under a control, or as the next of another menu. */
  readonly firstFocused: boolean
}

/**
 * The menu a control opens, over the page, one at a time. Esc, a click elsewhere or the focus leaving it closes it,
 * and the browser gives the focus back to where it was; arrows, Home and End go through the items. Its items go once
 * it has closed, on `toggle`: taken out as it closes, the item with the focus would take the focus with it.
 */
export const MenuHost = ({ children }: { readonly children: ComponentChildren }) => {
  const [shown, setShown] = useState(Option.none<Shown>())
  const popover = useRef<HTMLDivElement>(null)
  const menus = useMemo<Menus>(
    () => ({ open: (menu, at) => setShown(Option.some({ menu, at, firstFocused: MenuPlace.$is('Under')(at) })) }),
    []
  )
  useLayoutEffect(
    () =>
      Option.match(Option.all([shown, Option.fromNullishOr(popover.current)]), {
        onNone: () => {},
        onSome: ([{ at, firstFocused }, menu]) => {
          // Open already, as the next of another menu: it stays so.
          Boolean.match(menu.matches(':popover-open'), { onTrue: () => {}, onFalse: () => menu.showPopover() })
          place(menu, at)
          // From the pointer, no item is chosen yet, as in the system's menus.
          Boolean.match(firstFocused, { onTrue: () => focusAt(itemsOf(menu), 0), onFalse: () => menu.focus() })
        }
      }),
    [shown]
  )
  const close = () => Option.map(Option.fromNullishOr(popover.current), (menu) => menu.togglePopover(false))
  // The menu itself holds the focus while its items go: the item with it, taken out, would close it.
  const next = (menu: Menu) =>
    Option.map(Option.all([shown, Option.fromNullishOr(popover.current)]), ([{ at }, element]) => {
      element.focus()
      setShown(Option.some({ menu, at, firstFocused: true }))
    })
  const chose = (chosen: () => void) => () => {
    close()
    chosen()
  }
  /** What an item is to the browser, what a press of it does, and what it shows at its end. */
  const partsOf = (item: MenuItem) =>
    MenuItem.$match(item, {
      Action: ({ chosen }) => ({ role: 'menuitem' as const, onClick: chose(chosen), mark: null }),
      Choice: ({ chosen, checked }) => ({
        role: 'menuitemradio' as const,
        'aria-checked': checked,
        onClick: chose(chosen),
        mark: Boolean.match(checked, { onTrue: () => <Check class='menu__mark' />, onFalse: () => null })
      }),
      Next: ({ menu }) => ({
        role: 'menuitem' as const,
        'aria-haspopup': 'menu' as const,
        onClick: () => next(menu()),
        mark: <ChevronRight class='menu__mark' />
      })
    })
  const keyDown = (event: TargetedKeyboardEvent<HTMLDivElement>) => {
    const items = itemsOf(event.currentTarget)
    const at = Array.findFirstIndex(items, (item) => item === document.activeElement)
    const keys: Record<string, () => void> = {
      ArrowDown: () => focusAt(items, Option.match(at, { onNone: () => 0, onSome: (i) => (i + 1) % items.length })),
      ArrowUp: () =>
        focusAt(
          items,
          Option.match(at, { onNone: () => items.length - 1, onSome: (i) => (i - 1 + items.length) % items.length })
        ),
      Home: () => focusAt(items, 0),
      End: () => focusAt(items, items.length - 1),
      Tab: close,
      // Into the menu the item opens, as a system's menu goes into its own.
      ArrowRight: () =>
        Option.map(
          Option.filter(
            Option.flatMap(at, (i) => Array.get(items, i)),
            (item) => item.getAttribute('aria-haspopup') === 'menu'
          ),
          (item) => item.click()
        )
    }
    Option.match(Option.fromNullishOr(keys[event.key]), {
      onNone: () => {},
      onSome: (act) => {
        event.preventDefault()
        act()
      }
    })
  }
  const focusOut = (event: TargetedFocusEvent<HTMLDivElement>) =>
    Option.match(
      Option.liftPredicate(event.relatedTarget, (to) => to instanceof Node && event.currentTarget.contains(to)),
      { onNone: close, onSome: () => {} }
    )
  return (
    <MenusContext.Provider value={menus}>
      {children}
      <div
        ref={popover}
        popover='auto'
        class='menu'
        role='menu'
        tabIndex={-1}
        aria-label={Option.getOrUndefined(Option.map(shown, ({ menu }) => menu.title))}
        // One that opened again before the event comes says so: the browser sends one event for both.
        onToggle={(event) =>
          Boolean.match(event.newState === 'closed', { onTrue: () => setShown(Option.none()), onFalse: () => {} })
        }
        onKeyDown={keyDown}
        onFocusOut={focusOut}
        onContextMenu={(event) => event.preventDefault()}
      >
        {Option.match(shown, {
          onNone: () => null,
          onSome: ({ menu }) => (
            <>
              <div class='menu__title' aria-hidden='true'>
                {menu.title}
              </div>
              {/* By menu and place: two items may have one name, and a next menu takes this one's place. */}
              {menu.items.map((item, i) => {
                const { mark, ...does } = partsOf(item)
                return (
                  <button
                    key={`${menu.title}/${i}`}
                    type='button'
                    class='menu__item'
                    tabIndex={-1}
                    data-hint={item.hint}
                    {...does}
                  >
                    {item.icon}
                    {item.label}
                    {mark}
                  </button>
                )
              })}
            </>
          )
        })}
      </div>
    </MenusContext.Provider>
  )
}
