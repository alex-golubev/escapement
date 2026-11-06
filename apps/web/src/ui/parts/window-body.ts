import { createContext, type RefObject } from 'preact'
import { useContext } from 'preact/hooks'

/**
 * The body of the window it is drawn in, which scrolls what doesn't fit, as a ref: set before the effects of what is
 * in it run, with nothing drawn again for it. Outside a window, none.
 */
export const WindowBodyContext = createContext<RefObject<HTMLElement | null>>({ current: null })

export const useWindowBody = () => useContext(WindowBodyContext)
