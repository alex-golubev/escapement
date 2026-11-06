import { Array, Boolean, Data, Number, Option } from 'effect'
import {
  type ComponentChildren,
  createContext,
  type TargetedFocusEvent,
  type TargetedKeyboardEvent,
  type TargetedMouseEvent
} from 'preact'
import { useContext, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks'
import './menu.css'

export interface MenuItem {
  readonly label: string
  readonly icon: ComponentChildren
  readonly hint: string
  readonly chosen: () => void
  /** In a menu of choices, as the patterns to make current: whether it is the one chosen now. */
  readonly checked?: boolean
}

/** One of a list of choices, checked or not, or an action. */
const roleOf = ({ checked }: MenuItem) =>
  Option.match(Option.fromUndefinedOr(checked), {
    onNone: () => 'menuitem' as const,
    onSome: () => 'menuitemradio' as const
  })

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

/** Off the page's edges. */
const margin = 4

/** Between a control and its menu. */
const gap = 2

/** Along one axis: after what it opens from, or, where that runs past `room`, ending before it; off the edges. */
export const startOf = (after: number, before: number, size: number, room: number) =>
  Number.clamp(Boolean.match(after + size + margin <= room, { onTrue: () => after, onFalse: () => before - size }), {
    minimum: margin,
    maximum: Math.max(margin, room - size - margin)
  })

const fromOf = (place: MenuPlace) =>
  MenuPlace.$match(place, {
    Pointer: ({ x, y }) => ({ left: x, right: x, top: y, bottom: y }),
    Under: ({ control }) => {
      const { left, right, top, bottom } = control.getBoundingClientRect()
      return { left, right, top: top - gap, bottom: bottom + gap }
    }
  })

const place = (menu: HTMLElement, at: MenuPlace) => {
  const from = fromOf(at)
  const { width, height } = menu.getBoundingClientRect()
  menu.style.left = `${startOf(from.left, from.right, width, window.innerWidth)}px`
  menu.style.top = `${startOf(from.bottom, from.top, height, window.innerHeight)}px`
}

const itemsOf = (menu: HTMLElement) =>
  Array.fromIterable(menu.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"]'))

/** The choice checked, if the menu has one; otherwise its first item. */
const firstFocused = (items: ReadonlyArray<HTMLElement>) =>
  Option.getOrElse(
    Array.findFirstIndex(items, (item) => item.getAttribute('aria-checked') === 'true'),
    () => 0
  )

const focusAt = (items: ReadonlyArray<HTMLElement>, at: number) =>
  Option.map(Array.get(items, at), (item) => item.focus())

interface Shown {
  readonly menu: Menu
  readonly at: MenuPlace
}

/**
 * The menu a control opens, over every window, one at a time. Esc, a click elsewhere or the focus leaving it closes it,
 * and the browser gives the focus back to where it was; arrows, Home and End go through the items. Its items go once
 * it has closed, on `toggle`: taken out as it closes, the item with the focus would take the focus with it.
 */
export const MenuHost = ({ children }: { readonly children: ComponentChildren }) => {
  const [shown, setShown] = useState(Option.none<Shown>())
  const popover = useRef<HTMLDivElement>(null)
  const menus = useMemo<Menus>(() => ({ open: (menu, at) => setShown(Option.some({ menu, at })) }), [])
  useLayoutEffect(
    () =>
      Option.match(Option.all([shown, Option.fromNullishOr(popover.current)]), {
        onNone: () => {},
        onSome: ([{ at }, menu]) => {
          menu.showPopover()
          place(menu, at)
          // From the pointer, no item is chosen yet, as in the system's menus.
          MenuPlace.$match(at, {
            Pointer: () => menu.focus(),
            Under: () => {
              const items = itemsOf(menu)
              focusAt(items, firstFocused(items))
            }
          })
        }
      }),
    [shown]
  )
  const close = () => Option.map(Option.fromNullishOr(popover.current), (menu) => menu.togglePopover(false))
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
      Tab: close
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
              {/* By place: two items may have one name, as two patterns can, and a menu doesn't change while open. */}
              {menu.items.map((item, i) => (
                <button
                  key={i}
                  type='button'
                  role={roleOf(item)}
                  class='menu__item'
                  tabIndex={-1}
                  aria-checked={item.checked}
                  data-hint={item.hint}
                  onClick={() => {
                    close()
                    item.chosen()
                  }}
                >
                  {item.icon}
                  {item.label}
                </button>
              ))}
            </>
          )
        })}
      </div>
    </MenusContext.Provider>
  )
}
