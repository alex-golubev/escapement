// With no imports, so the browser's tests can lay out what the page does by the page's rem.

/** So many rems in whole CSS pixels, for a rem of `rem` pixels: lines drawn by them fall on pixels. */
export const pixelsOf = (rem: number, rems: number) => Math.round(rems * rem)

/** `x` CSS pixels moved to the nearest of the screen's points, `scale` to a CSS pixel: what is drawn from it stays sharp. */
export const onPoints = (x: number, scale: number) => Math.round(x * scale) / scale
