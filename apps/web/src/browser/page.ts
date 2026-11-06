import { Layer } from 'effect'
import { Page } from '../services/page'

/** The page's window, read as the layer is built: not where a module merely loads, as in a test without one. */
export const pageLayer = Layer.sync(Page, () => window)
