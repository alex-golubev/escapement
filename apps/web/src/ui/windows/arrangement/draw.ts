import { startInRound } from '@escapement/model'
import { Boolean } from 'effect'
import { paletteOf as tokensOf } from '../../kit/canvas'
import { barsInSight, type Drawn, tickUnder, tracksInSight, type View, wholesFrom, widthOf, xOf, yOf } from './geometry'
import { barWidth, namesWidth, rulerHeight, trackHeight } from './layout'

/** The arrangement's colours and fonts, as its style sheet and the interface's language give them. */
const tokens = {
  clip: '--shared',
  clipText: '--on-shared',
  clipEdge: '--arrangement-clip-edge',
  row: '--arrangement-row',
  rowLine: '--arrangement-row-line',
  barLine: '--arrangement-bar-line',
  phraseLine: '--arrangement-phrase-line',
  names: '--s-sunk',
  nameText: '--t-mid',
  edge: '--line',
  ruler: '--s-well',
  rulerText: '--t-lo',
  playhead: '--playhead',
  font: '--font',
  numbers: '--font-num'
} as const

export const paletteOf = tokensOf(tokens)

export type Palette = ReturnType<typeof paletteOf>

/** Bars by fours, as a phrase goes, each fourth's line the brighter. */
const phraseBars = 4

/** Draws inside the grid only, right of the names and under the ruler: what is scrolled past its edges goes under. */
const onGrid = (g: CanvasRenderingContext2D, view: View, draw: () => void) => {
  g.save()
  g.beginPath()
  g.rect(namesWidth, rulerHeight, view.width - namesWidth, view.height - rulerHeight)
  g.clip()
  draw()
  g.restore()
}

/** The tracks' rows and the lines between them and between bars. */
export const drawGrid = (g: CanvasRenderingContext2D, view: View, palette: Palette) =>
  onGrid(g, view, () => {
    g.fillStyle = palette.row
    g.fillRect(namesWidth, rulerHeight, view.width - namesWidth, view.height - rulerHeight)
    g.fillStyle = palette.rowLine
    tracksInSight(view).forEach((place) =>
      g.fillRect(namesWidth, yOf(view, place) + trackHeight - 1, view.width - namesWidth, 1)
    )
    barsInSight(view).forEach((bar) => {
      g.fillStyle = Boolean.match(bar % phraseBars === 0, {
        onTrue: () => palette.phraseLine,
        onFalse: () => palette.barLine
      })
      g.fillRect(namesWidth + bar * barWidth - view.left, rulerHeight, 1, view.height - rulerHeight)
    })
  })

/** Wide enough to name its pattern inside. */
const namedFrom = 16

/** Whether any of the clip is in sight on the grid. */
const shows = (view: View, clip: Drawn) =>
  xOf(view, clip.tick + clip.length) > namesWidth &&
  xOf(view, clip.tick) < view.width &&
  yOf(view, clip.place) + trackHeight > rulerHeight &&
  yOf(view, clip.place) < view.height

/** Where in the clip its pattern starts again, in sight: each round's start inside it, counted from its first. */
const roundsInSight = (view: View, { tick, length, period, offset }: Drawn): ReadonlyArray<number> => {
  // Where the round the clip starts in starts, at or before the clip.
  const into = startInRound(offset, period)
  const from = tick - into
  const first = Math.max(Math.ceil((tickUnder(view, namesWidth) - from) / period), 1)
  const last = Math.min(
    Math.floor((tickUnder(view, view.width) - from) / period),
    Math.ceil((length + into) / period) - 1
  )
  return wholesFrom(first, last).map((round) => from + round * period)
}

/**
 * Each clip in sight as long as it plays, on its track's row, a line where its pattern starts again, named after it, in
 * the order given: the last on top.
 */
export const drawClips = (g: CanvasRenderingContext2D, view: View, palette: Palette, clips: ReadonlyArray<Drawn>) =>
  onGrid(g, view, () => {
    g.font = `600 10px ${palette.font}`
    g.textAlign = 'left'
    g.textBaseline = 'middle'
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
        Boolean.match(width > namedFrom, {
          onTrue: () => {
            g.save()
            g.beginPath()
            g.rect(x, y, width - 4, height)
            g.clip()
            g.fillStyle = palette.clipText
            g.fillText(clip.name, x + 6, y + height / 2 + 0.5)
            g.restore()
          },
          onFalse: () => {}
        })
      })
  })

/** The bars' numbers along the top and the tracks' names down the left, over what scrolls under them. */
export const drawFrame = (g: CanvasRenderingContext2D, view: View, palette: Palette) => {
  g.fillStyle = palette.ruler
  g.fillRect(0, 0, view.width, rulerHeight)
  g.fillStyle = palette.edge
  g.fillRect(namesWidth, rulerHeight - 1, view.width - namesWidth, 1)
  g.save()
  g.beginPath()
  g.rect(namesWidth, 0, view.width - namesWidth, rulerHeight)
  g.clip()
  g.fillStyle = palette.rulerText
  g.font = `9px ${palette.numbers}`
  g.textAlign = 'left'
  g.textBaseline = 'middle'
  barsInSight(view).forEach((bar) =>
    g.fillText(String(bar + 1), namesWidth + bar * barWidth - view.left + 4, rulerHeight / 2)
  )
  g.restore()
  g.save()
  g.beginPath()
  g.rect(0, rulerHeight, namesWidth, view.height - rulerHeight)
  g.clip()
  g.fillStyle = palette.names
  g.fillRect(0, rulerHeight, namesWidth, view.height - rulerHeight)
  g.font = `10px ${palette.font}`
  g.textBaseline = 'middle'
  tracksInSight(view).forEach((place) => {
    const y = yOf(view, place)
    g.fillStyle = palette.edge
    g.fillRect(0, y + trackHeight - 1, namesWidth, 1)
    g.fillStyle = palette.nameText
    g.fillText(trackName(place), 8, y + trackHeight / 2)
  })
  g.restore()
  g.fillStyle = palette.edge
  g.fillRect(namesWidth - 1, rulerHeight, 1, view.height - rulerHeight)
}

/** A track's name while it has none of its own. */
export const trackName = (place: number) => `Track ${place + 1}`
