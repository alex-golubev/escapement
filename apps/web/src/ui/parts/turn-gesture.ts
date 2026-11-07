import { useAtomValue } from '@effect/atom-react'
import type { HoldTarget } from '@escapement/model'
import { Boolean, Number, Option, Record } from 'effect'
import type { TargetedKeyboardEvent, TargetedPointerEvent } from 'preact'
import { useEffect, useRef } from 'preact/hooks'
import type { Turn } from '../../services/turns'
import { useCore } from '../core-context'

/** How a control turns: in units a drag and a key move it by, kept in their range. */
export interface TurnScale {
  readonly units: (value: number) => number
  readonly value: (units: number) => number
  readonly range: { readonly minimum: number; readonly maximum: number }
  /** Pixels up per unit. */
  readonly pixelsPerUnit: number
  /** Units per arrow key press. */
  readonly step: number
  /** Where a double click puts it. */
  readonly default: number
}

/** With Shift, a tenth as far for the same move. */
const fine = 0.1

/** Where a key takes the control, in units, from where it stands. */
type KeyMove = (scale: TurnScale, from: number) => number

const steps =
  (count: number): KeyMove =>
  ({ step }, from) =>
    from + count * step

/** Arrow keys a step, page keys ten; Home and End to the ends. */
const keyMoves: Record.ReadonlyRecord<string, KeyMove> = {
  ArrowUp: steps(1),
  ArrowRight: steps(1),
  ArrowDown: steps(-1),
  ArrowLeft: steps(-1),
  PageUp: steps(10),
  PageDown: steps(-10),
  Home: ({ range }) => range.minimum,
  End: ({ range }) => range.maximum
}

/** Who turns it: a pointer, or the keys while one is held down. */
type Turner = number | 'keys'

interface Turning {
  readonly turn: Turn
  readonly by: Turner
  units: number
  moved: boolean
  y: number
}

/**
 * Turning a control by dragging it up or down, the pointer held to it until it is let go or lost, or by its keys: each
 * a turn of the control, released when it ends or the control goes. Returns the value to show, the one that plays, the
 * pointer's handlers, for the control and anything that turns it with a drag, and the keys', for the control alone.
 */
export const useTurnGesture = (target: HoldTarget, value: number, scale: TurnScale) => {
  const { session, turns } = useCore()
  // Another tab's hold comes as it sent it.
  const shown = Number.clamp(
    Option.getOrElse(useAtomValue(session.held(target)), () => value),
    {
      minimum: scale.value(scale.range.minimum),
      maximum: scale.value(scale.range.maximum)
    }
  )
  const turning = useRef(Option.none<Turning>())
  // A control that goes mid-turn, its track deleted elsewhere, lets go.
  useEffect(() => () => Option.match(turning.current, { onNone: () => {}, onSome: ({ turn }) => turn.release() }), [])
  /** The turn under way, if `by` turns it. */
  const turnBy = (by: Turner) => Option.filter(turning.current, (now) => now.by === by)
  const begin = (by: Turner, y = 0) => {
    const now: Turning = { turn: turns.begin(target, shown), by, units: scale.units(shown), moved: false, y }
    turning.current = Option.some(now)
    return now
  }
  /** Where a move goes from: until the page's first, what plays, which another tab may be turning meanwhile. */
  const from = (now: Turning) =>
    Boolean.match(now.moved, { onTrue: () => now.units, onFalse: () => scale.units(shown) })
  const moveTo = (now: Turning, units: number) => {
    // Kept in range, so a drag past an end turns back at once, and to a billionth, so moves adding up to an end land on it.
    now.units = Number.clamp(Number.round(units, 9), scale.range)
    now.moved = true
    now.turn.move(scale.value(now.units))
  }
  const end = (by: Turner) =>
    Option.match(turnBy(by), {
      onNone: () => {},
      onSome: ({ turn }) => {
        turn.release()
        turning.current = Option.none()
      }
    })
  return {
    value: shown,
    pointer: {
      onPointerDown: (event: TargetedPointerEvent<HTMLElement>) =>
        Boolean.match(event.button === 0 && Option.isNone(turning.current), {
          onFalse: () => {},
          onTrue: () => {
            // The control's own: a floating window would take a press with Shift for a drag of the whole window. The
            // press focuses the control, as the browser no longer does.
            event.preventDefault()
            event.currentTarget.focus()
            event.currentTarget.setPointerCapture(event.pointerId)
            begin(event.pointerId, event.clientY)
          }
        }),
      onPointerMove: (event: TargetedPointerEvent<HTMLElement>) =>
        Option.match(turnBy(event.pointerId), {
          onNone: () => {},
          onSome: (now) =>
            // Let go where the page didn't hear it, such as outside the window.
            Boolean.match(event.buttons === 0, {
              onTrue: () => {
                end(event.pointerId)
                Boolean.match(event.currentTarget.hasPointerCapture(event.pointerId), {
                  onTrue: () => event.currentTarget.releasePointerCapture(event.pointerId),
                  onFalse: () => {}
                })
              },
              onFalse: () => {
                const pixels =
                  (now.y - event.clientY) * Boolean.match(event.shiftKey, { onTrue: () => fine, onFalse: () => 1 })
                now.y = event.clientY
                // A move sideways is no turn: a value off the knob's grid would come back from its position changed.
                Option.map(
                  Option.liftPredicate(pixels, (up) => up !== 0),
                  (up) => moveTo(now, from(now) + up / scale.pixelsPerUnit)
                )
              }
            })
        }),
      onPointerUp: (event: TargetedPointerEvent<HTMLElement>) => end(event.pointerId),
      onPointerCancel: (event: TargetedPointerEvent<HTMLElement>) => end(event.pointerId),
      onLostPointerCapture: (event: TargetedPointerEvent<HTMLElement>) => end(event.pointerId),
      onDblClick: () => turns.set(target, scale.default)
    },
    keys: {
      // A key held down repeats: one turn until it is let go, written as a drag is.
      onKeyDown: (event: TargetedKeyboardEvent<HTMLElement>) =>
        Option.match(Record.get(keyMoves, event.key), {
          onNone: () => {},
          onSome: (move) => {
            event.preventDefault()
            const now = Option.getOrElse(turning.current, () => begin('keys'))
            // A drag under way keeps the control.
            Boolean.match(now.by === 'keys', { onTrue: () => moveTo(now, move(scale, from(now))), onFalse: () => {} })
          }
        }),
      onKeyUp: () => end('keys'),
      onBlur: () => end('keys')
    }
  }
}
