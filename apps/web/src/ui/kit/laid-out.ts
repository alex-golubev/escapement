import { Boolean, Equal, Option } from 'effect'
import type { RefObject } from 'preact'
import { useLayoutEffect, useState } from 'preact/hooks'
import type { Size } from './fit'

/**
 * The element's size inside, read again with each change of it, `measured` before each reading: behind a tab, the dock
 * takes a window out of the page, where it has neither size nor style, and puts it back as it comes forward.
 */
export const useLaidOutSize = (box: RefObject<HTMLElement | null>, measured: (element: HTMLElement) => void) => {
  const [size, setSize] = useState(Option.none<Size>())
  useLayoutEffect(
    () =>
      Option.match(Option.fromNullishOr(box.current), {
        onNone: () => undefined,
        onSome: (laid) => {
          const measure = () => {
            measured(laid)
            const now = { width: laid.clientWidth, height: laid.clientHeight }
            setSize((was) =>
              Boolean.match(Equal.equals(was, Option.some(now)), { onTrue: () => was, onFalse: () => Option.some(now) })
            )
          }
          measure()
          const observer = new ResizeObserver(measure)
          observer.observe(laid)
          return () => observer.disconnect()
        }
      }),
    []
  )
  return size
}
