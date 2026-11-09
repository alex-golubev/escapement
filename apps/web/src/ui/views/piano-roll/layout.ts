// The roll's sizes by the page's rem; importing nothing that imports, so the browser's tests can aim at its rows.
import { pixelsOf } from '../../kit/pixels'

/** The roll's sizes in whole CSS pixels, for a rem of `rem` pixels. */
export const layoutOf = (rem: number) => {
  const pixels = (rems: number) => pixelsOf(rem, rems)
  const keysWidth = pixels(3)
  return {
    /** A key's row. */
    rowHeight: pixels(0.75),
    /** A step's column: a bar of sixteen beside the keys. */
    stepWidth: pixels(2),
    /** The keyboard on the left. */
    keysWidth,
    /** A black key, from the keyboard's left edge: right of it, its row is the white keys' beside it, half each. */
    blackKeyWidth: Math.round(keysWidth * 0.6),
    /** The bars' numbers along the top. */
    rulerHeight: pixels(1.125),
    /** The bars' and the keys' numbers' type. */
    numbers: pixels(0.5625),
    /** The notes' names' type. */
    names: pixels(0.5),
    /** A note's corners, and a black key's. */
    corner: pixels(0.125),
    /** A gap of the grid: the bars' numbers from their lines, a note's name from its start, a key's from its end. */
    gap: pixels(0.25),
    /** A note wide enough to name its key inside. */
    namedFrom: pixels(1.375),
    /** The playhead's mark on the ruler: half its width, and its height. */
    mark: pixels(0.3125)
  }
}

export type Layout = ReturnType<typeof layoutOf>
