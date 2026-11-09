import { ticksPerQuarter } from '@escapement/engine-description'
import { barTicks, type NewNote, barSteps, stepTicks } from '@escapement/model'
import { Array, Boolean, Option } from 'effect'
import { paletteOf as tokensOf } from '../../kit/canvas'
import { isBlack, keysInSight, type View, widthOf, xOf, yOf } from './geometry'

const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

/** As most DAWs name a key: middle C, MIDI's 60, is C3. */
export const keyName = (key: number) => `${names[key % 12]}${Math.floor(key / 12) - 2}`

/** The roll's colours and fonts, as its style sheet and the interface's language give them. */
const tokens = {
  note: '--shared',
  noteText: '--on-shared',
  noteEdge: '--roll-note-edge',
  whiteRow: '--roll-white-row',
  blackRow: '--roll-black-row',
  rowLine: '--roll-row-line',
  octaveLine: '--roll-octave-line',
  stepLine: '--roll-step-line',
  beatLine: '--roll-beat-line',
  barLine: '--roll-bar-line',
  past: '--roll-past',
  whiteKey: '--roll-white-key',
  keyEdge: '--roll-key-edge',
  blackKey: '--roll-black-key',
  pressedKey: '--roll-pressed-key',
  keyName: '--roll-key-name',
  ruler: '--s-well',
  rulerText: '--t-lo',
  playhead: '--playhead',
  font: '--font'
} as const

export const paletteOf = tokensOf(tokens)

export type Palette = ReturnType<typeof paletteOf>

const stepsPerBeat = ticksPerQuarter / stepTicks

/** Of the lines between steps, a bar's the brightest, then a beat's. */
const lineOf = (step: number, palette: Palette) =>
  Option.getOrElse(
    Array.findFirst(
      [
        [barSteps, palette.barLine],
        [stepsPerBeat, palette.beatLine]
      ] as const,
      ([every]) => step % every === 0
    ).pipe(Option.map(([, line]) => line)),
    () => palette.stepLine
  )

/** Two white keys meet with no black one between them under C and under F. */
const meetsBelow = (key: number) => key % 12 === 0 || key % 12 === 5

/**
 * The keys in sight, the one that sounds pressed in the notes' colour: a white one with its halves of the black keys'
 * rows beside it.
 */
export const drawKeyboard = (
  g: CanvasRenderingContext2D,
  view: View,
  palette: Palette,
  pressed: Option.Option<number>
) => {
  const { keysWidth, blackKeyWidth, rowHeight, rulerHeight, corner } = view
  const isPressed = (key: number) => Option.contains(pressed, key)
  /** The key's colour, white or black, or pressed. */
  const colourOf = (key: number, unpressed: string) =>
    Boolean.match(isPressed(key), { onTrue: () => palette.pressedKey, onFalse: () => unpressed })
  g.save()
  // Under the ruler, as the grid's rows are.
  g.beginPath()
  g.rect(0, rulerHeight, keysWidth, view.height - rulerHeight)
  g.clip()
  keysInSight(view).forEach((key) => {
    const y = yOf(view, key)
    const half = rowHeight / 2
    Boolean.match(isBlack(key), {
      onTrue: () => {
        // Right of it, the white keys above and below, half the row each.
        g.fillStyle = colourOf(key + 1, palette.whiteKey)
        g.fillRect(0, y, keysWidth - 1, half)
        g.fillStyle = colourOf(key - 1, palette.whiteKey)
        g.fillRect(0, y + half, keysWidth - 1, half)
        // Where the black key splits the white ones beside it.
        g.fillStyle = palette.keyEdge
        g.fillRect(blackKeyWidth, y + half, keysWidth - 1 - blackKeyWidth, 1)
        g.fillStyle = colourOf(key, palette.blackKey)
        g.beginPath()
        g.roundRect(0, y + 1, blackKeyWidth, rowHeight - 2, [0, corner, corner, 0])
        g.fill()
      },
      onFalse: () => {
        g.fillStyle = colourOf(key, palette.whiteKey)
        g.fillRect(0, y, keysWidth - 1, rowHeight)
        g.fillStyle = palette.keyEdge
        Boolean.match(meetsBelow(key), {
          onTrue: () => g.fillRect(0, y + rowHeight - 1, keysWidth - 1, 1),
          onFalse: () => {}
        })
      }
    })
    Boolean.match(key % 12 === 0, {
      onTrue: () => {
        g.fillStyle = palette.keyName
        g.font = `${view.numbers}px ${palette.font}`
        g.textAlign = 'right'
        g.textBaseline = 'middle'
        g.fillText(keyName(key), keysWidth - view.gap, y + half + 0.5)
      },
      onFalse: () => {}
    })
  })
  g.restore()
}

/** Draws inside the grid's columns only, right of the keyboard: what is scrolled left of it goes under. */
const onGrid = (g: CanvasRenderingContext2D, view: View, draw: () => void) => {
  g.save()
  g.beginPath()
  g.rect(view.keysWidth, 0, view.width - view.keysWidth, view.height)
  g.clip()
  draw()
  g.restore()
}

/** Marks `every` pixels apart along the grid, by number: from the one at or left of its left edge to the last in sight. */
const inSightEvery = (view: View, every: number) =>
  Array.range(Math.floor(view.left / every), Math.floor((view.left + view.width - view.keysWidth) / every))

/** The rows, the lines between steps, what lies past the pattern's `end`, and the bars' numbers. */
export const drawGrid = (g: CanvasRenderingContext2D, view: View, palette: Palette, end: number) => {
  const { keysWidth, rowHeight, rulerHeight, stepWidth } = view
  const right = view.width - keysWidth
  keysInSight(view).forEach((key) => {
    const y = yOf(view, key)
    g.fillStyle = Boolean.match(isBlack(key), { onTrue: () => palette.blackRow, onFalse: () => palette.whiteRow })
    g.fillRect(keysWidth, y, right, rowHeight)
    // Under each C, the octave's line.
    g.fillStyle = Boolean.match(key % 12 === 0, { onTrue: () => palette.octaveLine, onFalse: () => palette.rowLine })
    g.fillRect(keysWidth, y + rowHeight - 1, right, 1)
  })
  onGrid(g, view, () => {
    inSightEvery(view, stepWidth).forEach((step) => {
      g.fillStyle = lineOf(step, palette)
      g.fillRect(xOf(view, step * stepTicks), rulerHeight, 1, view.height - rulerHeight)
    })
    const past = xOf(view, end) + 1
    g.fillStyle = palette.past
    g.fillRect(past, rulerHeight, view.width - past, view.height - rulerHeight)
  })
  g.fillStyle = palette.ruler
  g.fillRect(0, 0, view.width, rulerHeight)
  g.fillStyle = palette.stepLine
  g.fillRect(keysWidth, rulerHeight - 1, right, 1)
  g.fillStyle = palette.rulerText
  g.font = `${view.numbers}px ${palette.font}`
  g.textAlign = 'left'
  g.textBaseline = 'middle'
  // A bar scrolled partly out of sight takes its number under the keyboard with it.
  onGrid(g, view, () =>
    inSightEvery(view, barSteps * stepWidth).forEach((bar) =>
      g.fillText(String(bar + 1), xOf(view, bar * barTicks) + view.gap, rulerHeight / 2)
    )
  )
}

/** Whether any of the note is in sight on the grid. */
const shows = (view: View, note: NewNote) =>
  xOf(view, note.tick + note.length) > view.keysWidth &&
  xOf(view, note.tick) < view.width &&
  yOf(view, note.key) + view.rowHeight > view.rulerHeight &&
  yOf(view, note.key) < view.height

/** Each note in sight as long as it is, on its key's row, in the order given: the last on top. */
export const drawNotes = (g: CanvasRenderingContext2D, view: View, palette: Palette, notes: ReadonlyArray<NewNote>) => {
  const { keysWidth, rulerHeight, corner } = view
  g.save()
  g.beginPath()
  g.rect(keysWidth, rulerHeight, view.width - keysWidth, view.height - rulerHeight)
  g.clip()
  g.font = `600 ${view.names}px ${palette.font}`
  g.textAlign = 'left'
  g.textBaseline = 'middle'
  notes
    .filter((note) => shows(view, note))
    .forEach((note) => {
      const x = xOf(view, note.tick) + 1
      const y = yOf(view, note.key)
      const width = widthOf(view, note.length) - 1
      const height = view.rowHeight - 1
      g.fillStyle = palette.note
      g.beginPath()
      g.roundRect(x, y, width, height, corner)
      g.fill()
      g.strokeStyle = palette.noteEdge
      g.lineWidth = 1
      g.beginPath()
      g.roundRect(x + 0.5, y + 0.5, width - 1, height - 1, corner)
      g.stroke()
      Boolean.match(width > view.namedFrom, {
        onTrue: () => {
          g.fillStyle = palette.noteText
          g.fillText(keyName(note.key), x + view.gap, y + height / 2 + 0.5)
        },
        onFalse: () => {}
      })
    })
  g.restore()
}
