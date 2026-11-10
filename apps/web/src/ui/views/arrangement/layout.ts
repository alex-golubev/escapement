// The arrangement's sizes by the page's rem; importing nothing that imports, so the browser's tests can aim at its bars.
import { pixelsOf } from '../../kit/pixels'

/** The arrangement's sizes in whole CSS pixels, for a rem of `rem` pixels. */
export const layoutOf = (rem: number) => {
  const pixels = (rems: number) => pixelsOf(rem, rems)
  return {
    /** A track's row: its head's two lines, and room in a clip for its name and notes. */
    trackHeight: pixels(4),
    /** A bar's column. */
    barWidth: pixels(4),
    /** The tracks' heads, on the left, as wide as the prototype's: place, name, M and S over pan and volume. */
    headsWidth: pixels(18),
    /** The bars' numbers, along the top. */
    rulerHeight: pixels(1.125),
    /** The bars' numbers' type. */
    numbers: pixels(0.5625),
    /** A clip's corners. */
    corner: pixels(0.125),
    /** A clip off its row's top and bottom, so the rows' clips stand apart. */
    clipInset: pixels(0.375),
    /** A gap of the grid: the bars' numbers from their lines, a clip's round marks from its edges. */
    gap: pixels(0.25),
    /** The playhead's mark on the ruler: half its width, and its height. */
    mark: pixels(0.3125)
  }
}

export type Layout = ReturnType<typeof layoutOf>
