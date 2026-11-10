import { Option } from 'effect'
import type { RefObject } from 'preact'
import { useLayoutEffect, useRef } from 'preact/hooks'
import { cleared } from '../kit/canvas'
import type { Size } from '../kit/size'
import { type Follow, inSight, type Lane, useFollow } from './follow'
import { heardOf, useFrame } from './frames'

/**
 * A view drawn on canvases as its playhead goes along: its size, its lane, where a tick is across it, as its own
 * geometry has it, how high its ruler is, and the playhead's mark on it.
 */
export interface Laid {
  readonly size: Size
  readonly lane: Lane
  readonly xOf: (tick: number) => number
  readonly ruler: number
  readonly mark: number
}

/** The playhead's colours, as a view's palette names them: its line down the view, and its mark on the ruler. */
export interface Colours {
  readonly playhead: string
  readonly rulerText: string
}

/** A line down the view at the tick heard, playing or stopped, and a mark over it on the ruler; none out of sight. */
export const drawPlayhead = (
  g: CanvasRenderingContext2D,
  { size, lane, xOf, ruler, mark }: Laid,
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
      g.moveTo(x - mark + 1, ruler - mark - 1)
      g.lineTo(x + mark, ruler - mark - 1)
      g.lineTo(x + 0.5, ruler - 1)
      g.fill()
    }
  )

/** What a view drawn on canvases tells its playhead as it draws. */
export interface CanvasPlayhead {
  /** Where the arrangement's tick heard falls in the view's own time; none where the view doesn't show it. */
  readonly place: (tick: number) => Option.Option<number>
  /** The canvas over the others, the playhead's own. */
  readonly canvas: RefObject<HTMLCanvasElement | null>
  /** None until the view is laid out. */
  readonly laid: Option.Option<Laid>
  readonly colours: Option.Option<Colours>
  /** Whether a button is held on the view now. */
  readonly held: () => boolean
  /** Scrolls the view across to where the playhead takes it. */
  readonly scrollTo: (left: number) => void
}

/** The playhead over a canvas view, redrawn as the tick heard or the view changes; the view follows it as it plays. */
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
    const { tick, playing } = heardOf(frame)
    heard.current = place(tick)
    // The lane in sight: none behind a tab.
    const lane = Option.filter(
      Option.map(laid, ({ lane }) => lane),
      ({ width }) => width > 0
    )
    // Followed only as it plays: stopped, it is left where it stands, and Play brings it into sight.
    Option.map(
      follow.frame(
        lane,
        held(),
        Option.filter(heard.current, () => playing)
      ),
      scrollTo
    )
    draw()
  })
  return follow
}
