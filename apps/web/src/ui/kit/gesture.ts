import { Boolean, Option } from 'effect'
import type { TargetedMouseEvent, TargetedPointerEvent } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'

/** State the handlers read at once, as the page draws it later: both set by one call. */
export const useLatest = <A>(initial: A) => {
  const latest = useRef(initial)
  const [shown, setShown] = useState(initial)
  const set = (next: A) => {
    latest.current = next
    setShown(next)
  }
  return { latest, shown, set }
}

/** What a pointer holds from its press to its release. */
export interface Held {
  readonly pointer: number
  /** Ends the action of the undo history the gesture is, if it is one. */
  readonly end: () => void
}

/**
 * One gesture at a time, of the pointer that pressed, held by the element pressed until it is let go: kept on a release
 * or a capture lost, not when the browser cancels it. Let go of, it ends first, so what `letGo` writes can't keep its
 * action open; one the element goes in the middle of still lets go, or undo would wait for it for ever.
 */
export const usePointerGesture = <G extends Held>(letGo: (gesture: G, kept: boolean) => void) => {
  const gesture = useLatest(Option.none<G>())
  const release = useRef(letGo)
  release.current = letGo
  // A right click's menu comes on its press on a Mac and on its release on Windows: it does no more than the press.
  const pressedRight = useRef(false)
  const ended = (now: G, kept: boolean) => {
    now.end()
    release.current(now, kept)
  }
  const finish = (by: number, kept: boolean) =>
    Option.map(
      Option.filter(gesture.latest.current, (now) => now.pointer === by),
      (now) => {
        gesture.set(Option.none())
        ended(now, kept)
      }
    )
  useEffect(() => () => void Option.map(gesture.latest.current, (now) => ended(now, true)), [])
  return {
    gesture,
    /** A press, before what it starts: lets go of the gesture before, whose release went unheard. */
    pressed: (event: PointerEvent) => {
      Option.map(gesture.latest.current, (now) => finish(now.pointer, true))
      pressedRight.current = event.button === 2
    },
    /** Starts the press's gesture, the element's own: the browser neither selects text for it nor moves the focus. */
    take: (event: TargetedPointerEvent<HTMLElement>, next: G) => {
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      gesture.set(Option.some(next))
    },
    /** The gesture of the pointer moving, while a button holds it: one let go where the page didn't hear it, none. */
    moved: (event: TargetedPointerEvent<HTMLElement>): Option.Option<G> =>
      Option.flatMap(
        Option.filter(gesture.latest.current, (now) => now.pointer === event.pointerId),
        (now) =>
          Boolean.match(event.buttons === 0, {
            onTrue: () => {
              finish(event.pointerId, true)
              Boolean.match(event.currentTarget.hasPointerCapture(event.pointerId), {
                onTrue: () => event.currentTarget.releasePointerCapture(event.pointerId),
                onFalse: () => {}
              })
              return Option.none()
            },
            onFalse: () => Option.some(now)
          })
      ),
    handlers: {
      onPointerUp: (event: TargetedPointerEvent<HTMLElement>) => finish(event.pointerId, true),
      onPointerCancel: (event: TargetedPointerEvent<HTMLElement>) => finish(event.pointerId, false),
      onLostPointerCapture: (event: TargetedPointerEvent<HTMLElement>) => finish(event.pointerId, true)
    },
    /**
     * The browser's menu stays shut. One that comes of no right button's press, as of Ctrl and a click on a Mac, is a
     * right click, which `erase` takes.
     */
    menu: (erase: (event: TargetedMouseEvent<HTMLElement>) => void) => (event: TargetedMouseEvent<HTMLElement>) => {
      event.preventDefault()
      Boolean.match(Option.isSome(gesture.latest.current) || pressedRight.current, {
        onTrue: () => {},
        onFalse: () => erase(event)
      })
    }
  }
}
