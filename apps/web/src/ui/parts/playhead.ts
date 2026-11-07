import { Option } from 'effect'
import type { RefObject } from 'preact'
import { useLayoutEffect, useRef } from 'preact/hooks'
import { cleared } from '../kit/canvas'
import type { Size } from '../kit/fit'
import { type Follow, inSight, type Lane, useFollow } from './follow'
import { heardTick, useFrame } from './frames'

/**
 * A window drawn on canvases as its playhead goes along: its size, its lane, where a tick is across it, as its own
 * geometry has it, and how high its ruler is.
 */
export interface Laid {
  readonly size: Size
  readonly lane: Lane
  readonly xOf: (tick: number) => number
  readonly ruler: number
}

/** The playhead's colours, as a window's palette names them: its line down the window, and its mark on the ruler. */
export interface Colours {
  readonly playhead: string
  readonly rulerText: string
}

/** A line down the window at the tick heard, and a mark over it on the ruler; none while it is scrolled out of sight. */
export const drawPlayhead = (
  g: CanvasRenderingContext2D,
  { size, lane, xOf, ruler }: Laid,
  { playhead, rulerText }: Colours,
  tick: Option.Option<number>
) =>
  Option.map(
    Option.filter(tick, (heard) => inSight(lane, heard)),
    (heard) => {
      const x = Math.round(xOf(heard))
      g.fillStyle = playhead
      g.fillRect(x, ruler, 1, size.height - ruler)
      g.fillStyle = rulerText
      g.beginPath()
      g.moveTo(x - 4, ruler - 6)
      g.lineTo(x + 5, ruler - 6)
      g.lineTo(x + 0.5, ruler - 1)
      g.fill()
    }
  )

/** What a window drawn on canvases tells its playhead as it draws. */
export interface CanvasPlayhead {
  /** Where the arrangement's tick heard falls in the window's own time; none where the window doesn't show it. */
  readonly place: (tick: number) => Option.Option<number>
  /** The canvas over the others, the playhead's own. */
  readonly canvas: RefObject<HTMLCanvasElement | null>
  /** None until the window is laid out. */
  readonly laid: Option.Option<Laid>
  readonly colours: Option.Option<Colours>
  /** Whether a button is held on the window now. */
  readonly held: () => boolean
  /** Scrolls the window across to where the playhead takes it. */
  readonly scrollTo: (left: number) => void
}

/**
 * The playhead over a window drawn on canvases, drawn again as the tick heard or the window changes, not on every
 * frame, and the window following it; the `Follow` given is told of the window's scrolls by hand. A window scrolled
 * to the playhead is drawn anew before the frame shows, and so is the playhead on it, at the tick that frame heard.
 */
export const useCanvasPlayhead = ({ place, canvas, laid, colours, held, scrollTo }: CanvasPlayhead): Follow => {
  const follow = useFollow()
  const heard = useRef(Option.none<number>())
  const drawnAt = useRef('')
  const draw = () =>
    Option.map(Option.all({ laid, colours, on: Option.fromNullishOr(canvas.current) }), ({ laid, colours, on }) => {
      const { size, lane } = laid
      const now = `${size.width}:${size.height}:${lane.left}:${devicePixelRatio}@${Option.getOrElse(heard.current, () => -1)}`
      Option.map(
        Option.liftPredicate(now, (now) => now !== drawnAt.current),
        (now) => {
          drawnAt.current = now
          Option.map(cleared(on, size), (g) => drawPlayhead(g, laid, colours, heard.current))
        }
      )
    })
  useLayoutEffect(() => void draw())
  useFrame((frame) => {
    heard.current = Option.flatMap(heardTick(frame), place)
    // The lane in sight: none behind a tab.
    const lane = Option.filter(
      Option.map(laid, ({ lane }) => lane),
      ({ width }) => width > 0
    )
    Option.map(follow.frame(lane, held(), heard.current), scrollTo)
    draw()
  })
  return follow
}
