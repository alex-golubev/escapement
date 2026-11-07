import { startInRound } from '@escapement/model'
import { Boolean } from 'effect'
import { paletteOf as tokensOf } from '../../kit/canvas'
import { barsInSight, type Drawn, tickUnder, tracksInSight, type View, wholesFrom, widthOf, xOf, yOf } from './geometry'
import { barWidth, headsWidth, rulerHeight, trackHeight } from './layout'

/** The arrangement's colours and fonts, as its style sheet and the interface's language give them. */
const tokens = {
  clip: '--shared',
  clipEdge: '--arrangement-clip-edge',
  row: '--arrangement-row',
  rowLine: '--arrangement-row-line',
  barLine: '--arrangement-bar-line',
  phraseLine: '--arrangement-phrase-line',
  edge: '--line',
  ruler: '--s-well',
  rulerText: '--t-lo',
  playhead: '--playhead',
  numbers: '--font-num'
} as const

export const paletteOf = tokensOf(tokens)

export type Palette = ReturnType<typeof paletteOf>

/** Bars by fours, as a phrase goes, each fourth's line the brighter. */
const phraseBars = 4

/** Draws inside the grid only, right of the heads and under the ruler: what is scrolled past its edges goes under. */
const onGrid = (g: CanvasRenderingContext2D, view: View, draw: () => void) => {
  g.save()
  g.beginPath()
  g.rect(headsWidth, rulerHeight, view.width - headsWidth, view.height - rulerHeight)
  g.clip()
  draw()
  g.restore()
}

/** The tracks' rows and the lines between them and between bars; under the last one, the well. */
export const drawGrid = (g: CanvasRenderingContext2D, view: View, palette: Palette) =>
  onGrid(g, view, () => {
    // Where the tracks end down the window, as far as it shows.
    const bottom = Math.min(yOf(view, view.tracks), view.height)
    g.fillStyle = palette.row
    g.fillRect(headsWidth, rulerHeight, view.width - headsWidth, bottom - rulerHeight)
    g.fillStyle = palette.rowLine
    tracksInSight(view).forEach((place) =>
      g.fillRect(headsWidth, yOf(view, place) + trackHeight - 1, view.width - headsWidth, 1)
    )
    barsInSight(view).forEach((bar) => {
      g.fillStyle = Boolean.match(bar % phraseBars === 0, {
        onTrue: () => palette.phraseLine,
        onFalse: () => palette.barLine
      })
      g.fillRect(headsWidth + bar * barWidth - view.left, rulerHeight, 1, bottom - rulerHeight)
    })
  })

/** Whether any of the clip is in sight on the grid. */
const shows = (view: View, clip: Drawn) =>
  xOf(view, clip.tick + clip.length) > headsWidth &&
  xOf(view, clip.tick) < view.width &&
  yOf(view, clip.place) + trackHeight > rulerHeight &&
  yOf(view, clip.place) < view.height

/** Where in the clip its pattern starts again, in sight: each round's start inside it, counted from its first. */
const roundsInSight = (view: View, { tick, length, period, offset }: Drawn): ReadonlyArray<number> => {
  // Where the round the clip starts in starts, at or before the clip.
  const into = startInRound(offset, period)
  const from = tick - into
  const first = Math.max(Math.ceil((tickUnder(view, headsWidth) - from) / period), 1)
  const last = Math.min(
    Math.floor((tickUnder(view, view.width) - from) / period),
    Math.ceil((length + into) / period) - 1
  )
  return wholesFrom(first, last).map((round) => from + round * period)
}

/**
 * Each clip in sight as long as it plays, on its track's row, a line where its pattern starts again, in the order
 * given: the last on top.
 */
export const drawClips = (g: CanvasRenderingContext2D, view: View, palette: Palette, clips: ReadonlyArray<Drawn>) =>
  onGrid(g, view, () => {
    clips
      .filter((clip) => shows(view, clip))
      .forEach((clip) => {
        const x = xOf(view, clip.tick) + 1
        const y = yOf(view, clip.place) + 1
        const width = widthOf(clip.length) - 1
        const height = trackHeight - 3
        g.fillStyle = palette.clip
        g.beginPath()
        g.roundRect(x, y, width, height, 3)
        g.fill()
        g.strokeStyle = palette.clipEdge
        g.lineWidth = 1
        g.beginPath()
        g.roundRect(x + 0.5, y + 0.5, width - 1, height - 1, 3)
        g.stroke()
        g.fillStyle = palette.clipEdge
        roundsInSight(view, clip).forEach((start) => g.fillRect(Math.round(xOf(view, start)), y + 4, 1, height - 8))
      })
  })

/** The bars' numbers along the top, over what scrolls under them; the tracks' heads are drawn over the left. */
export const drawFrame = (g: CanvasRenderingContext2D, view: View, palette: Palette) => {
  g.fillStyle = palette.ruler
  g.fillRect(0, 0, view.width, rulerHeight)
  g.fillStyle = palette.edge
  g.fillRect(headsWidth, rulerHeight - 1, view.width - headsWidth, 1)
  g.save()
  g.beginPath()
  g.rect(headsWidth, 0, view.width - headsWidth, rulerHeight)
  g.clip()
  g.fillStyle = palette.rulerText
  g.font = `9px ${palette.numbers}`
  g.textAlign = 'left'
  g.textBaseline = 'middle'
  barsInSight(view).forEach((bar) =>
    g.fillText(String(bar + 1), headsWidth + bar * barWidth - view.left + 4, rulerHeight / 2)
  )
  g.restore()
}
