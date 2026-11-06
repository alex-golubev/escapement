import { Boolean } from 'effect'
import type { TargetedMouseEvent } from 'preact'

export interface Point {
  readonly x: number
  readonly y: number
}

/** Where the pointer is on the element the event is on. */
export const pointOf = (event: TargetedMouseEvent<HTMLElement>): Point => {
  const box = event.currentTarget.getBoundingClientRect()
  return { x: event.clientX - box.left, y: event.clientY - box.top }
}

/**
 * A press of the left button with Ctrl: a Mac's browser takes it as a right click, and says so with the menu it would
 * open; elsewhere it is no click yet.
 */
export const withCtrl = (event: PointerEvent) => event.button === 0 && event.ctrlKey

/** Across and down, in pixels. */
export interface Turn {
  readonly across: number
  readonly down: number
}

/**
 * How far a turn of the wheel scrolls, in pixels, whether it counts in them, in lines or in pages, as big as given: a
 * trackpad's either way; with Shift, a turn down goes across, as a browser on Windows may leave it; with Ctrl, as a
 * trackpad's pinch comes, nowhere yet.
 */
export const turnOf = (event: WheelEvent, line: Turn, page: Turn): Turn => {
  const turned = Boolean.match(event.shiftKey, {
    onTrue: () => ({ across: event.deltaX + event.deltaY, down: 0 }),
    onFalse: () => ({ across: event.deltaX, down: event.deltaY })
  })
  return Boolean.match(event.ctrlKey, {
    onTrue: () => ({ across: 0, down: 0 }),
    onFalse: () => ({
      across: turned.across * [1, line.across, page.across][event.deltaMode],
      down: turned.down * [1, line.down, page.down][event.deltaMode]
    })
  })
}
