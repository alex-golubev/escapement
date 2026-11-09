import { useAtom, useAtomValue } from '@effect/atom-react'
import { Tick } from '@escapement/engine-description'
import { byContent } from '@escapement/model'
import { Array, Boolean, Data, Equal, Option } from 'effect'
import type { TargetedMouseEvent, TargetedPointerEvent, TargetedWheelEvent } from 'preact'
import { useLayoutEffect, useMemo, useRef } from 'preact/hooks'
import { useCore } from '../../core-context'
import { useLayer, usePalette } from '../../kit/canvas'
import { useFontLoads } from '../../kit/font-loads'
import { useLatest, usePointerGesture } from '../../kit/gesture'
import { useLaidOutSize } from '../../kit/laid-out'
import { type Point, pointOf, turnOf, withCtrl } from '../../kit/pointer'
import { useRem } from '../../kit/rem'
import { onPoints } from '../../kit/pixels'
import { useScreenScale } from '../../kit/screen-scale'
import { useCanvasPlayhead } from '../../parts/playhead'
import { type Cursor, cursorAt, cursorOf, draggedClips, draggedTo, type Edge, Grab, grabAt } from './drag'
import { drawClips, drawFrame, drawGrid, paletteOf } from './draw'
import {
  barsAcross,
  clipAt,
  clipsAlong,
  endOf,
  inDrawingOrder,
  laneOf,
  type Shown,
  type Span,
  startAt,
  tracksDown,
  type View,
  xOf
} from './geometry'
import { TrackHeads } from './heads'
import { type Layout, layoutOf } from './layout'
import './arrangement.css'

/** The sizes the style sheet lays the heads out by, as the canvases have them. */
const sizesOf = ({ headsWidth, trackHeight, rulerHeight }: Layout) => ({
  '--heads-w': `${headsWidth}px`,
  '--track-h': `${trackHeight}px`,
  '--ruler-h': `${rulerHeight}px`
})

/**
 * What a pointer does from press to release, in an action of the undo history: erases all it passes over, as one step,
 * or drags a clip or its edge, written once, on release. The arrangement scrolls as far as its clips reached at the press until it
 * is let go: fewer would take the bars from under the pointer.
 */
type Gesture = Data.TaggedEnum<{
  Erasing: { readonly pointer: number; readonly end: () => void; readonly reached: number }
  Dragging: {
    readonly pointer: number
    readonly end: () => void
    readonly reached: number
    readonly grab: Grab
    readonly span: Span
  }
}>

const Gesture = Data.taggedEnum<Gesture>()

type Dragging = Data.TaggedEnum.Value<Gesture, 'Dragging'>

/**
 * The arrangement's body: the project's tracks, their heads down the left, and their clips, drawn on canvases, the grid,
 * the clips, the bars' numbers over them and the playhead, each drawn again only when what it shows changes. It fills
 * the middle, and follows the playhead.
 */
export const Arrangement = () => {
  const {
    registry,
    session,
    ops,
    view: { open: openClip, clip: openAtom, arrangementScroll }
  } = useCore()
  const tracksAtom = session.project.trackIds
  const shownAtom = useMemo(
    () =>
      byContent((get) => {
        const places = new Map(get(tracksAtom).map((track, place) => [track, place]))
        return inDrawingOrder(
          get(session.project.arrangementClips).map(
            ({ id, track, tick, length, period, offset }): Shown => ({
              id,
              // Each clip is on a live track, at its place.
              place: places.get(track) ?? -1,
              tick,
              length,
              period,
              offset
            })
          )
        )
      }),
    [session, tracksAtom]
  )
  const shown = useAtomValue(shownAtom)
  const open = useAtomValue(openAtom)
  const tracks = useAtomValue(tracksAtom).length
  const box = useRef<HTMLDivElement>(null)
  const grid = useRef<HTMLCanvasElement>(null)
  const clipsLayer = useRef<HTMLCanvasElement>(null)
  const frame = useRef<HTMLCanvasElement>(null)
  const over = useRef<HTMLCanvasElement>(null)
  const palette = usePalette(box, paletteOf)
  const size = useLaidOutSize(box)
  // In tracks and bars, so the same ones stand in sight at any size of the page.
  const [down, setDown] = useAtom(arrangementScroll.down)
  const [across, setAcross] = useAtom(arrangementScroll.across)
  const scale = useScreenScale()
  const rem = useRem()
  const fonts = useFontLoads()
  const layout = useMemo(() => layoutOf(rem), [rem])
  const pointer = useLatest(Option.none<Point>())
  /** What an edge let go writes: its end's length, or its start, length and offset together. */
  const edgeWrites: Record<Edge, (clip: Shown, span: Span) => boolean> = {
    end: (clip, { length }) => ops.resizeClip(clip.id, length),
    start: (clip, { tick, length, offset }) => ops.trimClip(clip.id, { tick: Tick(tick), length, offset })
  }
  /**
   * What a drag writes once let go: a clip put, or one moved, or made longer or shorter at an end; a press alone writes
   * nothing, so a clip as long as its pattern stays so.
   */
  const write = ({ grab, span }: Dragging) =>
    Grab.$match(grab, {
      // To the track at the row as it is now: none there, as tracks went meanwhile, nothing.
      Move: ({ clip }) =>
        Option.map(Array.get(registry.get(tracksAtom), span.place), (track) =>
          ops.moveClip(clip.id, { track, tick: Tick(span.tick) })
        ),
      Resize: ({ clip, edge }) =>
        Boolean.match(span.length === clip.length, {
          onTrue: () => true,
          onFalse: () => edgeWrites[edge](clip, span)
        })
    })
  // A drag kept writes where it left the clip, one the browser cancelled nothing.
  const gestures = usePointerGesture<Gesture>((now, kept) =>
    Gesture.$match(now, {
      Erasing: () => {},
      Dragging: (dragging) => Boolean.match(kept, { onTrue: () => void write(dragging), onFalse: () => {} })
    })
  )
  const { gesture } = gestures
  const drawing = Option.match(Option.filter(gesture.shown, Gesture.$is('Dragging')), {
    onNone: () => shown,
    onSome: ({ grab, span }) => draggedClips(shown, grab, span)
  })
  const end = endOf(drawing)
  const reach = Option.match(gesture.shown, { onNone: () => end, onSome: ({ reached }) => Math.max(reached, end) })
  const bars = barsAcross(reach, across)
  // Kept where it stands, as clips taken away take it back: clips put later move no bars.
  useLayoutEffect(() => setAcross(bars), [bars, across])
  const rows = Option.getOrElse(
    Option.map(size, ({ height }) => tracksDown(layout, height, tracks, down)),
    () => down
  )
  // Kept where it stands, as tracks taken away take it back: tracks put later move no rows.
  useLayoutEffect(() => setDown(rows), [rows, down])
  // Scrolled to the screen's points: a trackpad's fractions of a pixel, or a page grown, would blur every line.
  const top = onPoints(rows * layout.trackHeight, scale)
  const left = onPoints(bars * layout.barWidth, scale)
  const view = Option.map(size, (laid): View => ({ ...layout, ...laid, top, left, tracks }))
  const drawn = Option.all({ view, palette: palette.current })
  const viewKey = Option.match(view, {
    onNone: () => '',
    onSome: ({ width, height, top, left, tracks }) => `${width}:${height}:${top}:${left}:${tracks}:${scale}:${rem}`
  })
  useLayer(grid, drawn, (g, { view, palette }) => drawGrid(g, view, palette), [viewKey])
  // The bars' numbers are its only text, drawn again as the font comes.
  useLayer(frame, drawn, (g, { view, palette }) => drawFrame(g, view, palette), [viewKey, fonts])
  useLayer(clipsLayer, drawn, (g, { view, palette }) => drawClips(g, view, palette, drawing, open), [
    viewKey,
    shown,
    gesture.shown,
    open
  ])
  const playhead = useCanvasPlayhead({
    place: Option.some,
    canvas: over,
    laid: Option.map(view, (view) => ({
      size: view,
      lane: laneOf(view),
      xOf: (tick: number) => xOf(view, tick),
      ruler: view.rulerHeight,
      mark: view.mark
    })),
    colours: palette.current,
    held: () => Option.isSome(gesture.latest.current),
    scrollTo: (left) => setAcross(left / layout.barWidth)
  })
  /** Erases the clips on the way, as the document has them now: a drag can outrun what is drawn. */
  const eraseAlong = (from: Point, to: Point) =>
    Option.map(view, (view) =>
      Array.match(clipsAlong(registry.get(shownAtom), view, from, to), {
        onEmpty: () => {},
        onNonEmpty: (gone) => void ops.eraseClips(gone.map(({ id }) => id))
      })
    )
  /** Takes the clip held to where the pointer is over the arrangement as it stands. */
  const holdUnder = (now: Gesture, laid: View) =>
    Gesture.$match(now, {
      Erasing: () => {},
      Dragging: (dragging) =>
        Option.map(pointer.latest.current, (at) => {
          const span = draggedTo(dragging.grab, laid, at)
          Boolean.match(Equal.equals(span, dragging.span), {
            onTrue: () => {},
            onFalse: () => gesture.set(Option.some(Gesture.Dragging({ ...dragging, span })))
          })
        })
    })
  const onPointerDown = (event: TargetedPointerEvent<HTMLDivElement>) => {
    const point = pointOf(event)
    const by = event.pointerId
    gestures.pressed(event)
    pointer.set(Option.some(point))
    Boolean.match(event.button === 2, {
      onTrue: () => {
        gestures.take(event, Gesture.Erasing({ pointer: by, end: ops.begin(), reached: reach }))
        eraseAlong(point, point)
      },
      onFalse: () =>
        Option.map(
          Option.all({ view, left: Option.liftPredicate(event, (event) => event.button === 0 && !withCtrl(event)) }),
          ({ view }) =>
            Option.map(grabAt(registry.get(shownAtom), view, point), (grab) => {
              gestures.take(
                event,
                Gesture.Dragging({
                  pointer: by,
                  end: ops.begin(),
                  reached: reach,
                  grab,
                  span: draggedTo(grab, view, point)
                })
              )
            })
        )
    })
  }
  const onPointerMove = (event: TargetedPointerEvent<HTMLDivElement>) => {
    const point = pointOf(event)
    const was = pointer.latest.current
    pointer.set(Option.some(point))
    Option.map(gestures.moved(event), (now) =>
      Gesture.$match(now, {
        Erasing: () =>
          eraseAlong(
            Option.getOrElse(was, () => point),
            point
          ),
        Dragging: () => Option.map(view, (laid) => holdUnder(now, laid))
      })
    )
  }
  // On a track's empty row, a new clip from the bar's start.
  const onDblClick = (event: TargetedMouseEvent<HTMLDivElement>) =>
    Option.map(view, (now) => {
      const point = pointOf(event)
      Option.match(clipAt(registry.get(shownAtom), now, point), {
        onSome: ({ id }) => openClip(id),
        onNone: () =>
          Option.map(
            Option.flatMap(startAt(now, point), ({ place, tick }) =>
              Option.flatMap(Array.get(registry.get(tracksAtom), place), (track) =>
                ops.addClip({ track, tick: Tick(tick) })
              )
            ),
            openClip
          )
      })
    })
  const onWheel = (event: TargetedWheelEvent<HTMLDivElement>) =>
    Option.map(view, (now) => {
      event.preventDefault()
      const turn = turnOf(
        event,
        { across: now.barWidth, down: now.trackHeight },
        { across: now.width - now.headsWidth, down: now.height - now.rulerHeight }
      )
      const rowsTo = tracksDown(now, now.height, now.tracks, (now.top + turn.down) / now.trackHeight)
      const barsTo = barsAcross(reach, (now.left + turn.across) / now.barWidth)
      const next = {
        ...now,
        top: onPoints(rowsTo * now.trackHeight, scale),
        left: onPoints(barsTo * now.barWidth, scale)
      }
      setDown(rowsTo)
      setAcross(barsTo)
      playhead.scrolled(next.left !== now.left)
      // The clip dragged stays under the pointer as the tracks and the bars go by.
      Option.map(gesture.latest.current, (now) => holdUnder(now, next))
    })
  const cursor = Option.match(gesture.shown, {
    onSome: Gesture.$match({
      Erasing: (): Cursor => 'none',
      Dragging: ({ grab }) => cursorOf(grab)
    }),
    onNone: () =>
      Option.match(Option.all({ view, at: pointer.shown }), {
        onNone: (): Cursor => 'none',
        onSome: ({ view, at }) => cursorAt(shown, view, at)
      })
  })
  return (
    <div
      ref={box}
      class='arrangement'
      style={sizesOf(layout)}
      data-hint="The project's tracks and their clips, for everyone: a double click on a track's row puts a new clip there and opens it in the piano roll, a double click on a clip opens it; a drag moves a clip, to another track too, which plays it; a drag of either edge makes it shorter or longer, its notes going round again; a right click erases one, a drag with it all it passes over. Cmd+Z or Ctrl+Z takes it back. The wheel goes through the tracks; Shift and the wheel, or a swipe sideways, through the bars"
      onWheel={onWheel}
    >
      {/* Beside the heads, not under them: what is pressed on the heads never reaches the lanes' gestures. */}
      <div
        class='arrangement__lanes'
        data-grab={cursor}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        {...gestures.handlers}
        onContextMenu={gestures.menu((event) => eraseAlong(pointOf(event), pointOf(event)))}
        onDblClick={onDblClick}
      >
        <canvas ref={grid} />
        <canvas ref={clipsLayer} />
        <canvas ref={frame} />
        <canvas ref={over} />
      </div>
      <TrackHeads top={top} />
    </div>
  )
}
