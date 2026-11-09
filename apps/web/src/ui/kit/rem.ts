import { useEffect, useState } from 'preact/hooks'

/** A rem in CSS pixels: the root's font size, which the theme grows with the window. */
export const remOf = () => Number.parseFloat(getComputedStyle(document.documentElement).fontSize)

/** A rem in CSS pixels, read again as the window changes: what sizes drawn on a canvas, or set from code, are in. */
export const useRem = () => {
  const [rem, setRem] = useState(remOf)
  useEffect(() => {
    const changed = () => setRem(remOf())
    addEventListener('resize', changed)
    return () => removeEventListener('resize', changed)
  }, [])
  return rem
}
