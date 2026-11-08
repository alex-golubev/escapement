import { Boolean, Equal, Option } from 'effect'
import type { RefObject } from 'preact'
import { useLayoutEffect, useState } from 'preact/hooks'
import type { Size } from './size'

/** The element's size inside, read again with each change of it; none before it is laid out. */
export const useLaidOutSize = (box: RefObject<HTMLElement | null>) => {
  const [size, setSize] = useState(Option.none<Size>())
  useLayoutEffect(
    () =>
      Option.match(Option.fromNullishOr(box.current), {
        onNone: () => undefined,
        onSome: (laid) => {
          const measure = () => {
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
