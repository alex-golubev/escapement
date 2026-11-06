import { useAtomValue } from '@effect/atom-react'
import type { MidiKey } from '@escapement/engine-description'
import { byContent, type Id, type NewNote, patternEnd, stepNote } from '@escapement/model'
import { Array, Boolean, Data, Equal, Option } from 'effect'
import type { TargetedPointerEvent, TargetedWheelEvent } from 'preact'
import { useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks'
import { useCore } from '../../core-context'
import { useLayer } from '../../kit/canvas'
import { useLatest, usePointerGesture } from '../../kit/gesture'
import { useLaidOutSize } from '../../kit/laid-out'
import { type Point, pointOf, turnOf, withCtrl } from '../../kit/pointer'
import { useScreenScale } from '../../kit/screen-scale'
import { usePianoRollWindow } from '../../parts/piano-roll-window'
import { useCanvasPlayhead } from '../../parts/playhead'
import { drawGrid, drawKeyboard, drawNotes, type Palette, paletteOf } from './draw'
import { type Cursor, cursorAt, cursorOf, draggedNotes, draggedTo, Grab, grabAt } from './drag'
import {
  centredOn,
  keyboardKeyAt,
  laneOf,
  keyPlayedAt,
  notesAlong,
  scrolledAcross,
  scrolledTo,
  type View,
  xOf
} from './geometry'
import { keysWidth, rowHeight, rulerHeight, stepWidth } from './layout'
import './piano-roll.css'

/** The name of the channel the piano roll shows, beside its title. */
export const PianoRollName = () => {
  const { session } = useCore()
  const { channel } = usePianoRollWindow()
  const name = useMemo(
    () =>
      byContent((get) =>
        Option.flatMap(get(channel), (id) => Option.map(get(session.project.channel(id)), ({ name }) => name))
      ),
    [channel, session]
  )
  return Option.getOrElse(useAtomValue(name), () => 'No channel')
}

/**
 * What a pointer does from press to release: in an action of the undo history, erases all it passes over, as one step,
 * or drags a note, written once, on release, into the pattern it was pressed in; or plays a key of the keyboard, the one
 * it is over, writing nothing. The roll scrolls as far as the pattern reached at the press until it is let go: a shorter
 * one would take the bars from under the pointer. `id` tells a press from the next, on the same key too.
 */
type Gesture = Data.TaggedEnum<{
  Erasing: { readonly id: number; readonly pointer: number; readonly end: () => void; readonly reached: number }
  Playing: {
    readonly id: number
    readonly pointer: number
    readonly end: () => void
    readonly reached: number
    readonly key: MidiKey
  }
  Dragging: {
    readonly id: number
    readonly pointer: number
    readonly end: () => void
    readonly reached: number
    readonly pattern: Id
    readonly grab: Grab
    readonly place: NewNote
  }
}>

const Gesture = Data.taggedEnum<Gesture>()

type Dragging = Data.TaggedEnum.Value<Gesture, 'Dragging'>

/** The note a gesture plays to be heard: a key held, or a note held where it is, as loud as it is; none erasing. */
const soundOf = Gesture.$match({
  Erasing: () => Option.none<{ readonly key: MidiKey; readonly velocity: number }>(),
  Playing: ({ key }) => Option.some({ key, velocity: stepNote.velocity }),
  Dragging: ({ grab, place }) =>
    Option.some({
      key: place.key,
      velocity: Grab.$match(grab, {
        Put: () => stepNote.velocity,
        Move: ({ note }) => note.velocity,
        Stretch: ({ note }) => note.velocity
      })
    })
})

/**
 * The channel's notes on a grid of keys and steps, drawn on canvases: the grid, the notes, and the playhead over them,
 * each drawn again only when what it shows changes. It fills its window.
 */
const Roll = ({ channel, length }: { readonly channel: Id; readonly length: { current: number } }) => {
  const { registry, session, ops, host, run } = useCore()
  const notes = useAtomValue(session.notes(channel))
  const pattern = useAtomValue(session.pattern)
  const name = Option.getOrElse(
    Option.map(useAtomValue(session.project.channel(channel)), (found) => found.name),
    () => ''
  )
  const box = useRef<HTMLDivElement>(null)
  const grid = useRef<HTMLCanvasElement>(null)
  const keyboard = useRef<HTMLCanvasElement>(null)
  const pressCount = useRef(0)
  const notesLayer = useRef<HTMLCanvasElement>(null)
  const over = useRef<HTMLCanvasElement>(null)
  const palette = useRef(Option.none<Palette>())
  const size = useLaidOutSize(box, (laid) => {
    palette.current = Option.some(paletteOf(laid))
  })
  // Until scrolled, centred on the notes it opened with for the height it has: one behind a tab has none until it
  // comes forward.
  const [opening] = useState(() => registry.get(session.notes(channel)))
  const [scrolled, setScrolled] = useState(Option.none<number>())
  // Across from the first bar; the playhead takes it along.
  const [across, setAcross] = useState(0)
  const scale = useScreenScale()
  const pointer = useLatest(Option.none<Point>())
  // A drag kept writes where it left the note, one the browser cancelled nothing.
  const gestures = usePointerGesture<Gesture>((now, kept) =>
    Gesture.$match(now, {
      Erasing: () => {},
      Playing: () => {},
      Dragging: (dragging) => Boolean.match(kept, { onTrue: () => void write(dragging), onFalse: () => {} })
    })
  )
  const { gesture } = gestures
  const endWithout = useAtomValue(session.endWithout(channel))
  const drawing = Option.match(Option.filter(gesture.shown, Gesture.$is('Dragging')), {
    onNone: () => notes,
    onSome: ({ grab, place }) => draggedNotes(notes, channel, grab, place)
  })
  // As the notes drawn would make it: a drag into the next bar shows it in the pattern before it is let go.
  const end = Math.max(endWithout, patternEnd(drawing))
  const reach = Option.match(gesture.shown, { onNone: () => end, onSome: ({ reached }) => Math.max(reached, end) })
  const left = Option.match(size, { onNone: () => across, onSome: ({ width }) => scrolledAcross(width, reach, across) })
  // Kept where it stands, as a shorter pattern or a wider window takes it back: a longer pattern later moves no bars.
  useLayoutEffect(() => setAcross(left), [left, across])
  const view = Option.map(
    size,
    (laid): View => ({
      ...laid,
      top: scrolledTo(
        laid.height,
        Option.getOrElse(scrolled, () => centredOn(opening, laid.height))
      ),
      left
    })
  )
  const drawn = Option.all({ view, palette: palette.current })
  const viewKey = Option.match(view, {
    onNone: () => '',
    onSome: ({ width, height, top, left }) => `${width}:${height}:${top}:${left}:${scale}`
  })
  const sound = Option.flatMap(gesture.shown, (now) => Option.map(soundOf(now), (heard) => ({ ...heard, id: now.id })))
  const pressed = Option.map(sound, ({ key }) => key)
  const soundKey = Option.match(sound, {
    onNone: () => '',
    onSome: ({ id, key, velocity }) => `${id}:${key}:${velocity}`
  })
  // Heard from the press to the release, anew as the note held goes to another key; let go of as the roll goes too.
  useLayoutEffect(
    () => Option.getOrUndefined(Option.map(sound, ({ key, velocity }) => session.audition({ channel, key, velocity }))),
    [soundKey]
  )
  useLayer(grid, drawn, (g, { view, palette }) => drawGrid(g, view, palette, end), [viewKey, end])
  useLayer(keyboard, drawn, (g, { view, palette }) => drawKeyboard(g, view, palette, pressed), [
    viewKey,
    Option.getOrElse(pressed, () => -1)
  ])
  useLayer(notesLayer, drawn, (g, { view, palette }) => drawNotes(g, view, palette, drawing), [
    viewKey,
    notes,
    gesture.shown
  ])
  const playhead = useCanvasPlayhead({
    mode: 'pattern',
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
  /** What a drag writes once let go: a note put, or one moved or stretched, if it was; a press alone writes nothing. */
  const write = ({ pattern, grab, place }: Dragging) =>
    Grab.$match(grab, {
      Put: () => ops.addNote(pattern, channel, place),
      Move: ({ note }) => ops.moveNote(pattern, note.id, place),
      Stretch: ({ note }) => {
        length.current = place.length
        // A note in two of different lengths would be made one length.
        return Boolean.match(place.length === note.length, {
          onTrue: () => false,
          onFalse: () => ops.stretchNote(pattern, note.id, place.length)
        })
      }
    })
  /** Erases the notes on the way, as the document has them now: a drag can outrun what is drawn. */
  const eraseAlong = (from: Point, to: Point) =>
    Option.map(Option.all({ pattern, view }), ({ pattern, view }) =>
      Array.match(notesAlong(registry.get(session.notes(channel)), view, from, to), {
        onEmpty: () => {},
        onNonEmpty: (gone) =>
          void ops.eraseNotes(
            pattern,
            gone.map(({ id }) => id)
          )
      })
    )
  /** Takes the note held to where the pointer is over the roll as it stands. */
  const follow = (dragging: Dragging, now: View) =>
    Option.map(pointer.latest.current, (at) => {
      const place = draggedTo(dragging.grab, now, at)
      Boolean.match(Equal.equals(place, dragging.place), {
        onTrue: () => {},
        onFalse: () => gesture.set(Option.some(Gesture.Dragging({ ...dragging, place })))
      })
    })
  /** Keeps what is held under the pointer, over the roll as it stands: a note dragged, or the key played. */
  const holdUnder = (now: Gesture, laid: View) =>
    Gesture.$match(now, {
      Erasing: () => {},
      Playing: (playing) =>
        Option.map(pointer.latest.current, (at) => {
          const key = keyPlayedAt(laid, at)
          Boolean.match(key === playing.key, {
            onTrue: () => {},
            onFalse: () => gesture.set(Option.some(Gesture.Playing({ ...playing, key })))
          })
        }),
      Dragging: (dragging) => follow(dragging, laid)
    })
  const take = (event: TargetedPointerEvent<HTMLDivElement>, next: Gesture) => {
    // In the press itself, as the browser lets a press wake the sound.
    Option.map(soundOf(next), () => run(host.wake))
    gestures.take(event, next)
  }
  const onPointerDown = (event: TargetedPointerEvent<HTMLDivElement>) => {
    const point = pointOf(event)
    const by = event.pointerId
    const id = pressCount.current + 1
    pressCount.current = id
    gestures.pressed(event)
    pointer.set(Option.some(point))
    Boolean.match(event.button === 2, {
      onTrue: () => {
        take(event, Gesture.Erasing({ id, pointer: by, end: ops.begin(), reached: reach }))
        eraseAlong(point, point)
      },
      onFalse: () =>
        Option.map(
          Option.all({ view, left: Option.liftPredicate(event, (event) => event.button === 0 && !withCtrl(event)) }),
          ({ view }) =>
            Option.match(keyboardKeyAt(view, point), {
              // Nothing to undo: it writes nothing.
              onSome: (key) => take(event, Gesture.Playing({ id, pointer: by, end: () => {}, reached: reach, key })),
              onNone: () =>
                Option.map(
                  Option.flatMap(pattern, (pattern) =>
                    Option.map(grabAt(registry.get(session.notes(channel)), view, point, length.current), (grab) => ({
                      pattern,
                      grab
                    }))
                  ),
                  ({ pattern, grab }) => {
                    // A press on a note takes its length for the next; a new note is as long already.
                    length.current = grab.note.length
                    const place = draggedTo(grab, view, point)
                    take(
                      event,
                      Gesture.Dragging({ id, pointer: by, end: ops.begin(), reached: reach, pattern, grab, place })
                    )
                  }
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
        Playing: () => Option.map(view, (laid) => holdUnder(now, laid)),
        Dragging: () => Option.map(view, (laid) => holdUnder(now, laid))
      })
    )
  }
  const onWheel = (event: TargetedWheelEvent<HTMLDivElement>) =>
    Option.map(view, (now) => {
      event.preventDefault()
      const turn = turnOf(
        event,
        { across: stepWidth, down: rowHeight },
        { across: now.width - keysWidth, down: now.height }
      )
      const next = {
        ...now,
        top: scrolledTo(now.height, now.top + turn.down),
        left: scrolledAcross(now.width, reach, now.left + turn.across)
      }
      setScrolled(Option.some(next.top))
      setAcross(next.left)
      playhead.scrolled(next.left !== now.left)
      // The note dragged stays under the pointer as the rows and the bars go by, and the key played is the one under it.
      Option.map(gesture.latest.current, (now) => holdUnder(now, next))
    })
  const cursor = Option.match(gesture.shown, {
    onSome: Gesture.$match({
      Erasing: (): Cursor => 'none',
      Playing: (): Cursor => 'none',
      Dragging: ({ grab }) => cursorOf(grab)
    }),
    onNone: () =>
      Option.match(Option.all({ view, at: pointer.shown }), {
        onNone: (): Cursor => 'none',
        onSome: ({ view, at }) => cursorAt(notes, view, at)
      })
  })
  return (
    <div
      ref={box}
      class='roll'
      data-grab={cursor}
      data-hint={Option.match(pattern, {
        onNone: () => `${name}'s notes: no pattern plays, so there is nothing to put them in`,
        onSome: () =>
          `${name}'s notes, for everyone: a click puts one as long as the last one touched, a drag moves a note and its right edge makes it longer or shorter, a click on a note takes its length; a right click erases one, a drag with it all it passes over. Cmd+Z or Ctrl+Z takes it back. A press on a key, or on a note, plays it while held, when the pattern doesn't play. Shift and the wheel, or a swipe sideways, goes through the bars`
      })}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      {...gestures.handlers}
      onContextMenu={gestures.menu((event) => eraseAlong(pointOf(event), pointOf(event)))}
      onWheel={onWheel}
    >
      <canvas ref={grid} />
      <canvas ref={notesLayer} />
      <canvas ref={keyboard} />
      <canvas ref={over} />
    </div>
  )
}

/**
 * The piano roll's body: the notes of the channel it shows. The length of the note last touched carries over from one
 * channel to the next.
 */
export const PianoRoll = () => {
  const { channel } = usePianoRollWindow()
  const shown = useAtomValue(channel)
  const length = useRef(stepNote.length)
  return Option.match(shown, {
    onNone: () => <p class='roll-none'>No channels: + in the Channels window adds one</p>,
    onSome: (id) => <Roll key={id} channel={id} length={length} />
  })
}
