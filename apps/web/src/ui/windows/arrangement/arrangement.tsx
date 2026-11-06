import { useAtomValue } from '@effect/atom-react'
import { Tick } from '@escapement/engine-description'
import { byContent, arrangementTracks, trackPlace } from '@escapement/model'
import { Array, Boolean, Data, Equal, Option } from 'effect'
import type { TargetedPointerEvent, TargetedWheelEvent } from 'preact'
import { useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks'
import { useCore } from '../../core-context'
import { useLayer } from '../../kit/canvas'
import { useLatest, usePointerGesture } from '../../kit/gesture'
import { useLaidOutSize } from '../../kit/laid-out'
import { type Point, pointOf, turnOf, withCtrl } from '../../kit/pointer'
import { useScreenScale } from '../../kit/screen-scale'
import { useCanvasPlayhead } from '../../parts/playhead'
import { type Cursor, cursorAt, cursorOf, draggedClips, draggedTo, type Edge, Grab, grabAt, type Source } from './drag'
import { drawClips, drawFrame, drawGrid, type Palette, paletteOf } from './draw'
import {
  clipsAlong,
  endOf,
  inDrawingOrder,
  laneOf,
  type Shown,
  type Span,
  scrolledAcross,
  scrolledTo,
  type View,
  xOf
} from './geometry'
import { barWidth, namesWidth, rulerHeight, trackHeight } from './layout'
import './arrangement.css'

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
 * The arrangement's body: the clips of the live patterns on their tracks, drawn on canvases, the grid, the clips, the
 * names and numbers over them and the arrangement's playhead, each drawn again only when what it shows changes. It
 * fills its window, which follows the playhead.
 */
export const Arrangement = () => {
  const { registry, session, ops } = useCore()
  const shownAtom = useMemo(
    () =>
      byContent((get) =>
        inDrawingOrder(
          get(session.project.arrangementClips).flatMap(({ id, pattern, track, tick, length, period, offset }) =>
            Option.toArray(
              Option.map(
                trackPlace(track),
                (place): Shown => ({
                  id,
                  pattern,
                  place,
                  tick,
                  length,
                  period,
                  offset,
                  name: Option.getOrElse(get(session.project.patternName(pattern)), () => '')
                })
              )
            )
          )
        )
      ),
    [session]
  )
  const shown = useAtomValue(shownAtom)
  const box = useRef<HTMLDivElement>(null)
  const grid = useRef<HTMLCanvasElement>(null)
  const clipsLayer = useRef<HTMLCanvasElement>(null)
  const frame = useRef<HTMLCanvasElement>(null)
  const over = useRef<HTMLCanvasElement>(null)
  const palette = useRef(Option.none<Palette>())
  const size = useLaidOutSize(box, (laid) => {
    palette.current = Option.some(paletteOf(laid))
  })
  const [down, setDown] = useState(0)
  const [across, setAcross] = useState(0)
  const scale = useScreenScale()
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
    Option.map(Array.get(arrangementTracks, span.place), (track) => {
      const to = { track, tick: Tick(span.tick) }
      return Grab.$match(grab, {
        Put: ({ source }) => Option.isSome(ops.addClip(source.pattern, to)),
        Move: ({ clip }) => ops.moveClip(clip.id, to),
        // Either edge moved makes the clip longer or shorter.
        Resize: ({ clip, edge }) =>
          Boolean.match(span.length === clip.length, {
            onTrue: () => true,
            onFalse: () => edgeWrites[edge](clip, span)
          })
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
  const left = scrolledAcross(reach, across)
  // Kept where it stands, as clips taken away take it back: clips put later move no bars.
  useLayoutEffect(() => setAcross(left), [left, across])
  const view = Option.map(size, (laid): View => ({ ...laid, top: scrolledTo(laid.height, down), left }))
  const drawn = Option.all({ view, palette: palette.current })
  const viewKey = Option.match(view, {
    onNone: () => '',
    onSome: ({ width, height, top, left }) => `${width}:${height}:${top}:${left}:${scale}`
  })
  useLayer(grid, drawn, (g, { view, palette }) => drawGrid(g, view, palette), [viewKey])
  useLayer(frame, drawn, (g, { view, palette }) => drawFrame(g, view, palette), [viewKey])
  useLayer(clipsLayer, drawn, (g, { view, palette }) => drawClips(g, view, palette, drawing), [
    viewKey,
    shown,
    gesture.shown
  ])
  const playhead = useCanvasPlayhead({
    mode: 'arrangement',
    canvas: over,
    laid: Option.map(view, (view) => ({
      size: view,
      lane: laneOf(view),
      xOf: (tick: number) => xOf(view, tick),
      ruler: rulerHeight
    })),
    colours: palette.current,
    held: () => Option.isSome(gesture.latest.current),
    scrollTo: setAcross
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
  /** The pattern a click puts a clip of: the current one. */
  const source = (): Option.Option<Source> =>
    Option.map(registry.get(session.pattern), (pattern) => ({
      pattern,
      name: Option.getOrElse(registry.get(session.patternName), () => ''),
      length: registry.get(session.patternEnd)
    }))
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
            Option.map(grabAt(registry.get(shownAtom), view, point, source()), (grab) => {
              // A press on a clip makes its pattern the one the next click puts.
              Grab.$match(grab, {
                Move: ({ clip }) => session.choosePattern(clip.pattern),
                Resize: ({ clip }) => session.choosePattern(clip.pattern),
                Put: () => {}
              })
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
  const onWheel = (event: TargetedWheelEvent<HTMLDivElement>) =>
    Option.map(view, (now) => {
      event.preventDefault()
      const turn = turnOf(
        event,
        { across: barWidth, down: trackHeight },
        { across: now.width - namesWidth, down: now.height - rulerHeight }
      )
      const next = {
        ...now,
        top: scrolledTo(now.height, now.top + turn.down),
        left: scrolledAcross(reach, now.left + turn.across)
      }
      setDown(next.top)
      setAcross(next.left)
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
      data-grab={cursor}
      data-hint='Clips of patterns, for everyone: a click puts one of the current pattern, a drag moves a clip, a drag of either edge makes it shorter or longer, its pattern going round again; a press on one makes its pattern current; a right click erases one, a drag with it all it passes over. Cmd+Z or Ctrl+Z takes it back. The wheel goes through the tracks; Shift and the wheel, or a swipe sideways, through the bars'
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      {...gestures.handlers}
      onContextMenu={gestures.menu((event) => eraseAlong(pointOf(event), pointOf(event)))}
      onWheel={onWheel}
    >
      <canvas ref={grid} />
      <canvas ref={clipsLayer} />
      <canvas ref={frame} />
      <canvas ref={over} />
    </div>
  )
}
