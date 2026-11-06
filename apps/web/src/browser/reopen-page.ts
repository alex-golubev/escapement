/**
 * Where the page goes once its audio thread hung: served without cross-origin isolation, it gets a process of its own,
 * and the browser ends the one the page leaves, hung thread and all. It comes straight back.
 */
export const reopenPage = 'reopen.html'

/** Where `reopenPage` goes back to, for the tab only. */
export const backKey = 'escapement.back'
