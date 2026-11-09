import { useEffect, useState } from 'preact/hooks'

/** How many times the page's fonts have finished loading: a canvas draws its text again by it. */
export const useFontLoads = () => {
  const [loads, setLoads] = useState(0)
  useEffect(() => {
    const loaded = () => setLoads((count) => count + 1)
    void document.fonts.ready.then(loaded)
    document.fonts.addEventListener('loadingdone', loaded)
    return () => document.fonts.removeEventListener('loadingdone', loaded)
  }, [])
  return loads
}
