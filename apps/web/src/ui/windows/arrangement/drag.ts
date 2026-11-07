import { lastTick } from '@escapement/engine-description'
import { barTicks } from '@escapement/model'
import { Array, Data, Number, Option } from 'effect'
import { onLeftEdge, onRightEdge } from '../../kit/edge'
import type { Point } from '../../kit/pointer'
import {
  clipAt,
  type Drawn,
  type Place,
  rowAt,
  type Shown,
  type Span,
  tickUnder,
  type View,
  widthOf,
  xOf
} from './geometry'
import { headsWidth } from './layout'

/** Where on the arrangement a point is, as a track's place and a tick, past the grid too: a drag goes on outside it. */
interface Spot {
  readonly place: number
  readonly tick: number
}

const spotOf = (view: View, point: Point): Spot => ({ place: rowAt(view, point.y), tick: tickUnder(view, point.x) })

/** Which end of a clip an edge is. */
export type Edge = 'start' | 'end'

/**
 * What a press of the left button takes hold of, and where: a clip by its body, to move, or by an edge, to make it
 * shorter or longer at that end.
 */
export type Grab = Data.TaggedEnum<{
  Move: { readonly clip: Shown; readonly at: Spot }
  Resize: { readonly clip: Shown; readonly at: Spot; readonly edge: Edge }
}>

export const Grab = Data.taggedEnum<Grab>()

/** The cursor over what is held, or over what a press would take hold of. */
export type Cursor = 'move' | 'resize' | 'none'

/**
 * The edge of the clip the point is on, if it is: the end's, then the start's, each at most a third of the clip; the
 * start's only in sight, not scrolled under the tracks' heads.
 */
const edgeAt = (view: View, clip: Shown, x: number): Option.Option<Edge> => {
  const width = widthOf(clip.length)
  const start = xOf(view, clip.tick)
  return Option.firstSomeOf([
    Option.liftPredicate<Edge>('end', () => onRightEdge(x, xOf(view, clip.tick + clip.length), width)),
    Option.liftPredicate<Edge>('start', () => start >= headsWidth && onLeftEdge(x, start, width))
  ])
}

/** The clip under the point, and the edge of it the point is on, if it is. */
const partAt = (clips: ReadonlyArray<Shown>, view: View, point: Point) =>
  Option.map(clipAt(clips, view, point), (clip) => ({ clip, edge: edgeAt(view, clip, point.x) }))

/** What a press at the point takes hold of: a clip; nothing on empty ground or off the grid. */
export const grabAt = (clips: ReadonlyArray<Shown>, view: View, point: Point): Option.Option<Grab> => {
  const at = spotOf(view, point)
  return Option.map(partAt(clips, view, point), ({ clip, edge }) =>
    Option.match(edge, {
      onSome: (edge) => Grab.Resize({ clip, at, edge }),
      onNone: () => Grab.Move({ clip, at })
    })
  )
}

export const cursorAt = (clips: ReadonlyArray<Shown>, view: View, point: Point): Cursor =>
  Option.match(partAt(clips, view, point), {
    onNone: () => 'none',
    onSome: ({ edge }) => Option.match(edge, { onSome: (): Cursor => 'resize', onNone: (): Cursor => 'move' })
  })

export const cursorOf = Grab.$match({
  Move: (): Cursor => 'move',
  Resize: (): Cursor => 'resize'
})

/**
 * Moved by whole bars and tracks: from the first tick on, so as to end by the tick after the last, among the `tracks`
 * there are.
 */
const moved = (start: Omit<Span, 'offset'>, from: Spot, to: Spot, tracks: number): Place => ({
  place: Number.clamp(start.place + to.place - from.place, { minimum: 0, maximum: Math.max(tracks - 1, 0) }),
  tick:
    start.tick +
    Number.clamp(Math.round((to.tick - from.tick) / barTicks), {
      minimum: -Math.floor(start.tick / barTicks),
      maximum: Math.max(Math.floor((lastTick + 1 - start.tick - start.length) / barTicks), 0)
    }) *
      barTicks
})

/**
 * Longer or shorter by whole bars, from a bar on, ending by the tick after the last; one already shorter or ending later,
 * as another client may leave it, stays as it is until dragged the other way.
 */
const resized = ({ place, tick, length, offset }: Span, from: Spot, to: Spot): Span => {
  const longest = Math.floor((lastTick + 1 - tick) / barTicks) * barTicks
  return {
    place,
    tick,
    offset,
    length: Number.clamp(length + Math.round((to.tick - from.tick) / barTicks) * barTicks, {
      minimum: Math.min(barTicks, length),
      maximum: Math.max(longest, length)
    })
  }
}

/**
 * Started earlier or later by whole bars, its end where it was: no earlier than the first tick, a bar long at least, as
 * long as it was if shorter; its pattern's rounds stay where they were, its offset going with the start.
 */
const trimmed = (clip: Shown, from: Spot, to: Spot): Span => {
  const by =
    Number.clamp(Math.round((to.tick - from.tick) / barTicks), {
      minimum: -Math.floor(clip.tick / barTicks),
      maximum: Math.max(Math.floor((clip.length - barTicks) / barTicks), 0)
    }) * barTicks
  return {
    place: clip.place,
    tick: clip.tick + by,
    length: clip.length - by,
    offset: clip.offset + by
  }
}

/** The span an edge held makes with the pointer at the spot. */
const edges: Record<Edge, (clip: Shown, from: Spot, to: Spot) => Span> = { start: trimmed, end: resized }

/** Where the clip held stands and how long it is with the pointer at the point; at the press, as it was. */
export const draggedTo = (grab: Grab, view: View, point: Point): Span => {
  const to = spotOf(view, point)
  return Grab.$match(grab, {
    Move: ({ clip, at }) => ({ ...moved(clip, at, to, view.tracks), length: clip.length, offset: clip.offset }),
    Resize: ({ clip, at, edge }) => edges[edge](clip, at, to)
  })
}

/** The clips with the one held as the drag has it, on top. One gone meanwhile shows nowhere. */
const withHeld = (clips: ReadonlyArray<Shown>, clip: Shown, held: (now: Shown) => Shown): ReadonlyArray<Drawn> =>
  Option.match(
    Array.findFirst(clips, ({ id }) => id === clip.id),
    {
      onNone: () => clips,
      onSome: (now) => [...clips.filter(({ id }) => id !== clip.id), held(now)]
    }
  )

/** The clips as a drag shows them, the one held on top where it is held, as long. */
export const draggedClips = (
  clips: ReadonlyArray<Shown>,
  grab: Grab,
  { place, tick, length, offset }: Span
): ReadonlyArray<Drawn> =>
  Grab.$match(grab, {
    Move: ({ clip }) => withHeld(clips, clip, (now) => ({ ...now, place, tick })),
    Resize: ({ clip }) => withHeld(clips, clip, (now) => ({ ...now, tick, length, offset }))
  })
