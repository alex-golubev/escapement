// The half of the drawing a test can reach. The components that mount these
// cannot be run here at all, which is why the arithmetic was taken out of them.

import { describe, expect, it } from 'vitest'

import { paintMeters, paintPlayhead } from './paint'
import type { Canvas2D } from './paint'

/** Sixteen cells across a round width, so a cell is exactly 8. */
const FIELD = { width: 128, height: 40, steps: 16 }

const PLAYHEAD = { line: '#fff', wash: '#111' }
const METERS = { track: '#222', bar: '#0f0', over: '#f00' }

describe('paintPlayhead', () => {
  it('clears before it draws', () => {
    // Not for the sake of transparency: the line from the previous frame is two
    // pixels wide and stays exactly where it was, so a playhead that skipped
    // this would fill the bar in with itself over one loop.
    const canvas = recorder()

    paintPlayhead(canvas.ctx, FIELD, PLAYHEAD, { step: 3 })

    expect(canvas.calls[0]).toMatchObject({ op: 'clear', x: 0, y: 0, width: 128, height: 40 })
  })

  it('lights the cell the position is inside, not the nearest one', () => {
    // `round` would light cell 8 from 7.5 onward — that is half a step of grid
    // running ahead of the sound, everywhere except on the boundaries where the
    // two agree anyway. The floor is also what `Telemetry.step` tells the page
    // to use, so a second answer here would be a second answer to a question
    // already settled across the wire.
    const canvas = recorder()

    paintPlayhead(canvas.ctx, FIELD, PLAYHEAD, { step: 7.9 })

    expect(canvas.filled(PLAYHEAD.wash)).toEqual([{ x: 56, y: 0, width: 8, height: 40 }])
  })

  it('puts the line on the boundary at a whole step, and between them in between', () => {
    const onTheBeat = recorder()
    paintPlayhead(onTheBeat.ctx, FIELD, PLAYHEAD, { step: 4 })
    // Centred on x = 32, which is where cell 3 ends and cell 4 begins.
    expect(onTheBeat.filled(PLAYHEAD.line)).toEqual([{ x: 31, y: 0, width: 2, height: 40 }])

    const halfway = recorder()
    paintPlayhead(halfway.ctx, FIELD, PLAYHEAD, { step: 4.5 })
    expect(halfway.filled(PLAYHEAD.line)).toEqual([{ x: 35, y: 0, width: 2, height: 40 }])
  })

  it('reaches the far edge on the last cell rather than a gap short of it', () => {
    // The failure a column gap in the stylesheet would cause looks exactly like
    // this and only here: right at cell 0, adrift by a whole gap at cell 15.
    const canvas = recorder()

    paintPlayhead(canvas.ctx, FIELD, PLAYHEAD, { step: 15 })

    expect(canvas.filled(PLAYHEAD.wash)).toEqual([{ x: 120, y: 0, width: 8, height: 40 }])
  })
})

describe('paintMeters', () => {
  it('fills each bar in proportion, and lays them out without overlapping', () => {
    const canvas = recorder()

    paintMeters(canvas.ctx, { width: 100, height: 13 }, METERS, { peakL: 0.5, peakR: 0.25 })

    // Five high each, three apart: the second starts where the first ends plus
    // the split, which is the only arithmetic here that can put one bar on top
    // of the other.
    expect(canvas.filled(METERS.bar)).toEqual([
      { x: 0, y: 0, width: 50, height: 5 },
      { x: 0, y: 8, width: 25, height: 5 },
    ])
  })

  it('draws an empty bar under a silent one, so silence has a shape', () => {
    const canvas = recorder()

    paintMeters(canvas.ctx, { width: 100, height: 13 }, METERS, { peakL: 0, peakR: 0 })

    expect(canvas.filled(METERS.track)).toHaveLength(2)
    expect(canvas.filled(METERS.bar)).toEqual([
      { x: 0, y: 0, width: 0, height: 5 },
      { x: 0, y: 8, width: 0, height: 5 },
    ])
  })

  it('stops at full scale and says so in colour', () => {
    // The reading is taken before the limiter and the sum is hot by decision, so
    // this is the ordinary state of a busy pattern rather than an edge case.
    // Drawn past the end it would be invisible; clamped and left green it would
    // be indistinguishable from a bus sitting exactly at unity.
    const canvas = recorder()

    paintMeters(canvas.ctx, { width: 100, height: 13 }, METERS, { peakL: 5.66, peakR: 1 })

    expect(canvas.filled(METERS.over)).toEqual([{ x: 0, y: 0, width: 100, height: 5 }])
    expect(canvas.filled(METERS.bar)).toEqual([{ x: 0, y: 8, width: 100, height: 5 }])
  })
})

/**
 * A context that remembers what it was asked to draw.
 *
 * Local to this file because it has one consumer, and it is a plain object
 * rather than a cast `CanvasRenderingContext2D` because `Canvas2D` is narrow
 * enough to implement honestly — which is the point of its being narrow.
 */
function recorder() {
  const calls: {
    op: string
    x: number
    y: number
    width: number
    height: number
    fill: string
  }[] = []

  let fill = ''

  const ctx: Canvas2D = {
    get fillStyle() {
      return fill
    },
    // The interface carries the whole of the real property's type, because a
    // property is invariant and narrowing it would lock the browser's own
    // context out. What it therefore cannot say is that the painters only ever
    // set a colour — so this says it, and would fail loudly rather than record
    // an object as a string.
    set fillStyle(value) {
      if (typeof value !== 'string')
        throw new Error('a painter set something that is not a colour')
      fill = value
    },
    clearRect(x, y, width, height) {
      calls.push({ op: 'clear', x, y, width, height, fill })
    },
    fillRect(x, y, width, height) {
      calls.push({ op: 'fill', x, y, width, height, fill })
    },
  }

  return {
    ctx,
    calls,
    /** Every rectangle painted in one colour, in the order it was painted. */
    filled: (colour: string) =>
      calls
        .filter((call) => call.op === 'fill' && call.fill === colour)
        .map(({ x, y, width, height }) => ({ x, y, width, height })),
  }
}
