// With no imports, so the browser's tests can aim at an edge.

/** A thing's edge, which a press stretches it by, in CSS pixels: at most a third of it. */
export const edgeWidth = 6

/** Whether `x` is on the right edge of a thing drawn `width` wide that ends at `end`. */
export const onRightEdge = (x: number, end: number, width: number) => x >= end - Math.min(edgeWidth, width / 3)

/** Whether `x` is on the left edge of a thing drawn `width` wide that starts at `start`. */
export const onLeftEdge = (x: number, start: number, width: number) => x < start + Math.min(edgeWidth, width / 3)
