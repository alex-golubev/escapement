import { useEffect, useState } from 'preact/hooks'

/** The screen's pixels to a CSS pixel, drawn again when it changes, as the window moves to another screen. */
export const useScreenScale = () => {
  const [scale, setScale] = useState(devicePixelRatio)
  useEffect(() => {
    const query = matchMedia(`(resolution: ${scale}dppx)`)
    const changed = () => setScale(devicePixelRatio)
    query.addEventListener('change', changed)
    return () => query.removeEventListener('change', changed)
  }, [scale])
  return scale
}
