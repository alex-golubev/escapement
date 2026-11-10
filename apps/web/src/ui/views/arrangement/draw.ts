import { type Colour, firstColour, type Id, startInRound } from '@escapement/model'
import { Array, Boolean, Option } from 'effect'
import { paletteOf as tokensOf } from '../../kit/canvas'
import {
  barsInSight,
  type Drawn,
  type Shown,
  tickUnder,
  tracksInSight,
  type View,
  wholesFrom,
  widthOf,
  xOf,
  yOf
} from './geometry'

/** The arrangement's colours and fonts, as its style sheet and the interface's language give them. */
const tokens = {
  open: '--t-hi',
  row: '--arrangement-row',
  rowLine: '--arrangement-row-line',
  barLine: '--arrangement-bar-line',
  phraseLine: '--arrangement-phrase-line',
  edge: '--line',
  ruler: '--s-well',
  rulerText: '--t-lo',
  playhead: '--playhead',
  font: '--font'
} as const

export const paletteOf = tokensOf(tokens)

export type Palette = ReturnType<typeof paletteOf>

/** Bars by fours, as a phrase goes, each fourth's line the brighter. */
const phraseBars = 4

/** Of a clip's colour, how much its fill takes, over the row: its edge takes it whole. */
const fillShare = 0.4

/** How much of itself a clip of a track not heard shows, as its head dims. */
const unheardShare = 0.4

/** How far the open clip's edge goes from its colour to the light: in its colour still, and told apart. */
const openLight = 0.5

/** Draws inside the grid only, right of the heads and under the ruler: what is scrolled past its edges goes under. */
const onGrid = (g: CanvasRenderingContext2D, view: View, draw: () => void) => {
  g.save()
  g.beginPath()
  g.rect(view.headsWidth, view.rulerHeight, view.width - view.headsWidth, view.height - view.rulerHeight)
  g.clip()
  draw()
  g.restore()
}

/** The tracks' rows and the lines between them and between bars; under the last one, the well. */
export const drawGrid = (g: CanvasRenderingContext2D, view: View, palette: Palette) =>
  onGrid(g, view, () => {
    const { headsWidth, rulerHeight, trackHeight, barWidth } = view
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
  xOf(view, clip.tick + clip.length) > view.headsWidth &&
  xOf(view, clip.tick) < view.width &&
  yOf(view, clip.place) + view.trackHeight > view.rulerHeight &&
  yOf(view, clip.place) < view.height

/** Where in the clip its pattern starts again, in sight: each round's start inside it, counted from its first. */
const roundsInSight = (view: View, { tick, length, period, offset }: Drawn): ReadonlyArray<number> => {
  // Where the round the clip starts in starts, at or before the clip.
  const into = startInRound(offset, period)
  const from = tick - into
  const first = Math.max(Math.ceil((tickUnder(view, view.headsWidth) - from) / period), 1)
  const last = Math.min(
    Math.floor((tickUnder(view, view.width) - from) / period),
    Math.ceil((length + into) / period) - 1
  )
  return wholesFrom(first, last).map((round) => from + round * period)
}

/** What a track's row gives the clips on it: its track's colour, and whether the track is heard. */
export interface RowLook {
  readonly colour: Colour
  readonly heard: boolean
}

/** Where the rows don't say, as a clip taken past the last track: the palette's first colour, heard. */
const anyRow: RowLook = { colour: firstColour, heard: true }

/** Each clip in sight in its row's colour, the last on top: a share of it filled, edged with it whole; dimmed unheard. */
export const drawClips = (
  g: CanvasRenderingContext2D,
  view: View,
  palette: Palette,
  clips: ReadonlyArray<Shown>,
  looks: ReadonlyArray<RowLook>,
  open: Option.Option<Id>
) =>
  onGrid(g, view, () => {
    clips
      .filter((clip) => shows(view, clip))
      .forEach((clip) => {
        const { corner, gap, clipInset } = view
        const { colour, heard } = Option.getOrElse(Array.get(looks, clip.place), () => anyRow)
        // Off the bar's line it starts on, up to the next one's: two clips one after another stand a line apart.
        const x = xOf(view, clip.tick) + 1
        const y = yOf(view, clip.place) + clipInset
        const width = widthOf(view, clip.length) - 1
        const height = view.trackHeight - 2 * clipInset
        const shown = Boolean.match(heard, { onTrue: () => 1, onFalse: () => unheardShare })
        // On the row's own colour first: see-through as its fill is, a clip over another still hides it.
        g.fillStyle = palette.row
        g.beginPath()
        g.roundRect(x, y, width, height, corner)
        g.fill()
        g.fillStyle = colour
        g.strokeStyle = colour
        g.globalAlpha = shown * fillShare
        g.fill()
        g.globalAlpha = shown
        g.lineWidth = 1
        g.beginPath()
        g.roundRect(x + 0.5, y + 0.5, width - 1, height - 1, corner)
        g.stroke()
        roundsInSight(view, clip).forEach((start) =>
          g.fillRect(Math.round(xOf(view, start)), y + gap, 1, height - 2 * gap)
        )
        Boolean.match(Option.contains(open, clip.id), {
          onTrue: () => {
            g.strokeStyle = palette.open
            g.globalAlpha = shown * openLight
            g.beginPath()
            g.roundRect(x + 0.5, y + 0.5, width - 1, height - 1, corner)
            g.stroke()
          },
          onFalse: () => {}
        })
        g.globalAlpha = 1
      })
  })

/** The bars' numbers along the top, over what scrolls under them; the tracks' heads are drawn over the left. */
export const drawFrame = (g: CanvasRenderingContext2D, view: View, palette: Palette) => {
  const { headsWidth, rulerHeight, barWidth } = view
  g.fillStyle = palette.ruler
  g.fillRect(0, 0, view.width, rulerHeight)
  g.fillStyle = palette.edge
  g.fillRect(headsWidth, rulerHeight - 1, view.width - headsWidth, 1)
  g.save()
  g.beginPath()
  g.rect(headsWidth, 0, view.width - headsWidth, rulerHeight)
  g.clip()
  g.fillStyle = palette.rulerText
  g.font = `${view.numbers}px ${palette.font}`
  g.textAlign = 'left'
  g.textBaseline = 'middle'
  barsInSight(view).forEach((bar) =>
    g.fillText(String(bar + 1), headsWidth + bar * barWidth - view.left + view.gap, rulerHeight / 2)
  )
  g.restore()
}
