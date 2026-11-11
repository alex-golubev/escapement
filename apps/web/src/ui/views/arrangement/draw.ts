import { ticksPerQuarter } from '@escapement/engine-description'
import { barTicks, type Colour, firstColour, type Id, startInRound } from '@escapement/model'
import { Array, Boolean, Option } from 'effect'
import { paletteOf as tokensOf } from '../../kit/canvas'
import {
  barsInSight,
  type Drawn,
  noteHeightOf,
  notesPlayed,
  noteTop,
  type Preview,
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
  name: '--t-hi',
  note: '--t-mid',
  preview: '--s-sunk',
  row: '--arrangement-row',
  rowLine: '--arrangement-row-line',
  barLine: '--arrangement-bar-line',
  phraseLine: '--arrangement-phrase-line',
  edge: '--line',
  ruler: '--s-sunk',
  rulerLine: '--line-soft',
  beat: '--line',
  rulerText: '--t-lo',
  loop: '--shared',
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

/** How much of the dark under its notes a clip's preview takes, over the clip's colour. */
const previewShare = 0.6

/** How much of the amber the loop's band takes, as the prototype's does. */
const loopShare = 0.7

/** A bar's beats, a mark at each after the first. */
const beatsInBar = barTicks / ticksPerQuarter

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

/** What a track's row gives the clips on it: its track's name and colour, and whether the track is heard. */
export interface RowLook {
  readonly name: string
  readonly colour: Colour
  readonly heard: boolean
}

/** Where the rows don't say, as a clip taken past the last track or on one gone: no name, the first colour, heard. */
export const anyRow: RowLook = { name: '', colour: firstColour, heard: true }

/** A clip as drawn: where, how big, in what colour and how much of it shows. */
interface ClipBox {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly colour: Colour
  readonly shown: number
}

/** Inside a clip, cut to it: its preview's dark, its rounds' lines, its notes as played, its name at its left in sight. */
const drawInside = (
  g: CanvasRenderingContext2D,
  view: View,
  palette: Palette,
  clip: Shown,
  name: string,
  preview: Option.Option<Preview>,
  { x, y, width, height, colour, shown }: ClipBox
) => {
  const { clipHead, clipPadding, previewInset, noteHeight, corner, gap } = view
  g.save()
  g.beginPath()
  g.roundRect(x, y, width, height, corner)
  g.clip()
  const top = y + clipHead
  const bottom = y + height - 1
  g.fillStyle = palette.preview
  g.globalAlpha = shown * previewShare
  g.fillRect(x + 1, top, width - 2, bottom - top)
  g.globalAlpha = shown
  g.fillStyle = colour
  roundsInSight(view, clip).forEach((start) => g.fillRect(Math.round(xOf(view, start)), y + gap, 1, height - 2 * gap))
  // Notes one after another stand a pixel apart; one from the clip's start loses only the bar's line to its edge.
  Option.map(preview, (notes) => {
    const room = bottom - top - 2 * previewInset
    const thick = noteHeightOf(notes, room, noteHeight)
    g.fillStyle = palette.note
    notesPlayed(clip, notes, tickUnder(view, view.headsWidth), tickUnder(view, view.width)).forEach(
      ({ start, end, key }) => {
        const left = Math.round(xOf(view, start))
        g.fillRect(
          left,
          Math.round(top + previewInset + noteTop(notes, key, room, thick)),
          Math.max(Math.round(xOf(view, end)) - left - 1, 1),
          thick
        )
      }
    )
  })
  g.fillStyle = palette.name
  g.fillText(name, Math.max(x, view.headsWidth) + clipPadding, y + clipHead / 2)
  g.restore()
}

/** Each clip in sight in its row's colour, the last on top, with its name and notes inside; dimmed while unheard. */
export const drawClips = (
  g: CanvasRenderingContext2D,
  view: View,
  palette: Palette,
  clips: ReadonlyArray<Shown>,
  looks: ReadonlyArray<RowLook>,
  previews: ReadonlyMap<Id, Preview>,
  open: Option.Option<Id>
) =>
  onGrid(g, view, () => {
    g.font = `${view.clipName}px ${palette.font}`
    g.textAlign = 'left'
    g.textBaseline = 'middle'
    g.lineWidth = 1
    clips
      .filter((clip) => shows(view, clip))
      .forEach((clip) => {
        const { corner, clipInset } = view
        const { name, colour, heard } = Option.getOrElse(Array.get(looks, clip.place), () => anyRow)
        // Off the bar's line it starts on, up to the next one's: two clips one after another stand a line apart.
        const box: ClipBox = {
          x: xOf(view, clip.tick) + 1,
          y: yOf(view, clip.place) + clipInset,
          width: widthOf(view, clip.length) - 1,
          height: view.trackHeight - 2 * clipInset,
          colour,
          shown: Boolean.match(heard, { onTrue: () => 1, onFalse: () => unheardShare })
        }
        const { x, y, width, height, shown } = box
        // On the row's own colour first: see-through as its fill is, a clip over another still hides it.
        g.fillStyle = palette.row
        g.beginPath()
        g.roundRect(x, y, width, height, corner)
        g.fill()
        g.fillStyle = colour
        g.globalAlpha = shown * fillShare
        g.fill()
        // Its edge under its notes, lightened on the open one.
        g.strokeStyle = colour
        g.globalAlpha = shown
        g.beginPath()
        g.roundRect(x + 0.5, y + 0.5, width - 1, height - 1, corner)
        g.stroke()
        Boolean.match(Option.contains(open, clip.id), {
          onTrue: () => {
            g.strokeStyle = palette.open
            g.globalAlpha = shown * openLight
            g.stroke()
          },
          onFalse: () => {}
        })
        drawInside(g, view, palette, clip, name, Option.fromUndefinedOr(previews.get(clip.pattern)), box)
        g.globalAlpha = 1
      })
  })

/** A bar's number on the ruler, from 0, as the prototype writes its start: `01.01.00`. */
export const barText = (bar: number) => `${String(bar + 1).padStart(2, '0')}.01.00`

/** The ruler, under the heads' corner at its left: each bar's line, number and beats, the loop's band to `loopEnd`. */
export const drawFrame = (g: CanvasRenderingContext2D, view: View, palette: Palette, loopEnd: number) => {
  const { headsWidth, rulerHeight, barWidth, beatMark } = view
  g.fillStyle = palette.ruler
  g.fillRect(0, 0, view.width, rulerHeight)
  g.fillStyle = palette.edge
  g.fillRect(headsWidth, rulerHeight - 1, view.width - headsWidth, 1)
  g.save()
  g.beginPath()
  g.rect(headsWidth, 0, view.width - headsWidth, rulerHeight - 1)
  g.clip()
  g.font = `${view.numbers}px ${palette.font}`
  g.textAlign = 'left'
  g.textBaseline = 'middle'
  barsInSight(view).forEach((bar) => {
    const x = headsWidth + bar * barWidth - view.left
    g.fillStyle = palette.rulerLine
    g.fillRect(x, 0, 1, rulerHeight - 1)
    g.fillStyle = palette.beat
    wholesFrom(1, beatsInBar - 1).forEach((beat) =>
      g.fillRect(x + Math.round((beat * barWidth) / beatsInBar), rulerHeight - 1 - beatMark, 1, beatMark)
    )
    g.fillStyle = palette.rulerText
    // Squeezed into its bar past the thousandth, as no wider bar holds it.
    g.fillText(barText(bar), x + view.numbersInset, rulerHeight / 2, barWidth - 2 * view.numbersInset)
  })
  g.fillStyle = palette.loop
  g.globalAlpha = loopShare
  g.fillRect(xOf(view, 0), 0, widthOf(view, loopEnd), view.loopBand)
  g.restore()
}
