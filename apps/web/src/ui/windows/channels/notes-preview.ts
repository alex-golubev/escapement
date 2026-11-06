import { barTicks, type Note } from '@escapement/model'
import { Array, Boolean, Option } from 'effect'
import { barWidth, endOf, xOf } from './geometry'
import { barGap } from './layout'

/** Room kept down, under the row's light. */
const down = 4

/** The widest a canvas may be, in the browser's pixels, in every browser. */
const widestCanvas = 32_767

/**
 * The channel's notes as thin lit lines on the steps' scale, each bar under the bar of steps, from the lowest key's at
 * the bottom to the highest's at the top, one key in the middle; every other bar of the pattern's `bars` a shade
 * lighter, and past them darker.
 */
export const drawPreview = (canvas: HTMLCanvasElement, notes: ReadonlyArray<Note>, bars: number) =>
  Option.map(Option.fromNullishOr(canvas.getContext('2d')), (g) => {
    const width = canvas.clientWidth
    const height = canvas.clientHeight
    // Sharp on the screen, as far as a canvas so wide may be.
    const scale = Math.min(devicePixelRatio, widestCanvas / Math.max(width, 1))
    canvas.width = Math.round(width * scale)
    canvas.height = Math.round(height * scale)
    g.setTransform(scale, 0, 0, scale, 0, 0)
    const style = getComputedStyle(canvas)
    g.fillStyle = style.getPropertyValue('--preview-bar').trim()
    Array.range(0, bars - 1)
      .filter((at) => at % 2 === 1)
      .forEach((at) => g.fillRect(xOf(at * barTicks), 1, barWidth, height - 2))
    g.fillStyle = style.getPropertyValue('--preview-past').trim()
    const past = xOf(bars * barTicks) - barGap / 2
    g.fillRect(past, 1, width - 1 - past, height - 2)
    const keys = notes.map(({ key }) => key)
    const low = Math.min(...keys)
    const high = Math.max(...keys)
    const level = (key: number) =>
      Boolean.match(high === low, { onTrue: () => 0.5, onFalse: () => (key - low) / (high - low) })
    const lit = style.getPropertyValue('--shared').trim()
    g.fillStyle = lit
    g.shadowColor = lit
    g.shadowBlur = 4
    notes.forEach((note) => {
      g.beginPath()
      g.roundRect(
        xOf(note.tick),
        down + (1 - level(note.key)) * (height - down * 2 - 2),
        Math.max(endOf(note.tick + note.length) - xOf(note.tick) - 1, 2),
        2,
        1
      )
      g.fill()
    })
  })
