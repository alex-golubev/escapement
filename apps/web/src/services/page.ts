import { Context } from 'effect'

/** The page itself, for the events that say it is hidden, shown again or going: the browser's window, a test's own. */
export class Page extends Context.Service<Page, EventTarget>()('Page') {}
