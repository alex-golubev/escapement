// The roll's sizes, in CSS pixels; with no imports, so the browser's tests can aim at its rows and steps.

/** A key's row. */
export const rowHeight = 12

/** A step's column: a bar of sixteen, 512 pixels, beside the keys. */
export const stepWidth = 32

/** The keyboard on the left. */
export const keysWidth = 48

/** A black key, from the keyboard's left edge: right of it, its row is the white keys' beside it, half each. */
export const blackKeyWidth = Math.round(keysWidth * 0.6)

/** The bars' numbers along the top. */
export const rulerHeight = 18
