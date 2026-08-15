// What the two moving surfaces on this page draw, and nothing about how they
// are mounted.
//
// Split out of the components for the same reason `render.ts` is split out of
// `processor.ts`: nothing in this package can execute a `.svelte` file — the
// suite runs under Node with no DOM and no component runner — so arithmetic
// left inside one is arithmetic no test ever runs. What stays over there is the
// element, its size and the subscription, where a test could only assert that
// the calls I made were the calls I made.
//
// Both take a context narrowed to the three things they touch, in the idiom
// `DecodedSample` already follows in kit.ts: against the whole of
// `CanvasRenderingContext2D` every path here would need a browser, or a cast
// pretending there was one.
//
// Both also take the telemetry reading itself rather than the numbers picked
// out of it. Two bare numbers side by side are the pair a reader swaps and the
// compiler accepts — the same trap `Impulse` was given a named fixture for —
// and here the caller already holds the whole reading anyway.

/**
 * As much of a 2D context as anything below touches.
 *
 * `fillStyle` keeps the whole of the real property's type even though nothing
 * here assigns anything but a string. A property is invariant, so narrowing it
 * would make the browser's own context unassignable to this — the opposite of
 * what narrowing an interface is for, and a cast at both call sites to undo.
 */
export interface Canvas2D {
  fillStyle: string | CanvasGradient | CanvasPattern
  clearRect(x: number, y: number, width: number, height: number): void
  fillRect(x: number, y: number, width: number, height: number): void
}

/**
 * A box to draw in, in CSS pixels.
 *
 * CSS and not device pixels: the caller has already put the device scale into
 * the context's transform, so everything here is in the units the stylesheet
 * next to it is written in, and a line two units wide is two pixels on any
 * screen.
 */
export interface Box {
  readonly width: number
  readonly height: number
}

/** A box holding `steps` cells of equal width. */
export interface Field extends Box {
  readonly steps: number
}

export interface PlayheadColours {
  /** The line itself. */
  readonly line: string
  /** The column under it, laid over the cells rather than in place of them. */
  readonly wash: string
}

/** Width of the playhead line, in CSS pixels. */
const LINE = 2

/**
 * Draw the playhead across a field of equally wide cells.
 *
 * Equal width is a real condition, and the stylesheet beside the canvas is what
 * keeps it: the cells sit in a grid with no column gap, so cell `i` occupies
 * exactly `[i·w, (i+1)·w)` and the width alone is enough to find it. Given a
 * gap, every cell but the first would sit further right than this computes, and
 * by the sixteenth the line would be a whole gap adrift — wrong at the end of
 * the bar and right at the beginning, which is the way round nobody notices.
 */
export function paintPlayhead(
  ctx: Canvas2D,
  field: Field,
  colours: PlayheadColours,
  reading: { readonly step: number },
): void {
  // First, and not because the wash is translucent: without it the line from
  // the previous frame stays, and a playhead that leaves a trail draws the
  // whole bar within a loop.
  ctx.clearRect(0, 0, field.width, field.height)

  const cell = field.width / field.steps

  // Floor, which is what the page is told to use — `Telemetry.step` says so,
  // and says where the fraction-of-a-sample disagreement with the engine's own
  // rounding is argued and why it is not fixed. Not `round`: that lights the
  // next cell through the whole second half of this one, so the grid would run
  // half a step ahead of the sound at every moment except the boundaries.
  ctx.fillStyle = colours.wash
  ctx.fillRect(Math.floor(reading.step) * cell, 0, cell, field.height)

  // Centred on the position rather than starting at it, so the line sits on the
  // boundary at a whole step instead of just after it.
  ctx.fillStyle = colours.line
  ctx.fillRect(reading.step * cell - LINE / 2, 0, LINE, field.height)
}

export interface MeterColours {
  /** The empty bar, so that silence still has a shape. */
  readonly track: string
  readonly bar: string
  /** Past full scale, which is a different reading and not a fuller one. */
  readonly over: string
}

/** Space between the two bars, in CSS pixels. */
const SPLIT = 3

/** Left above right, both filling the width of the box. */
export function paintMeters(
  ctx: Canvas2D,
  box: Box,
  colours: MeterColours,
  reading: { readonly peakL: number; readonly peakR: number },
): void {
  ctx.clearRect(0, 0, box.width, box.height)

  const height = (box.height - SPLIT) / 2
  paintBar(ctx, { x: 0, y: 0, width: box.width, height }, colours, reading.peakL)
  paintBar(ctx, { x: 0, y: height + SPLIT, width: box.width, height }, colours, reading.peakR)
}

function paintBar(
  ctx: Canvas2D,
  rect: {
    readonly x: number
    readonly y: number
    readonly width: number
    readonly height: number
  },
  colours: MeterColours,
  peak: number,
): void {
  ctx.fillStyle = colours.track
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height)

  // Full scale is where the bar ends and not where the level does. This is read
  // before the limiter and the sum is hot by decision, so a busy pattern runs
  // past 1 as a matter of course — see `Telemetry.peakL`. Drawn past the end it
  // would be invisible; clamped and left the same colour it would read as
  // merely loud, which is the one thing a meter on a hot bus exists to tell
  // apart. So the fill stops and the colour says the rest.
  ctx.fillStyle = peak > 1 ? colours.over : colours.bar
  ctx.fillRect(rect.x, rect.y, Math.min(1, Math.max(0, peak)) * rect.width, rect.height)
}
