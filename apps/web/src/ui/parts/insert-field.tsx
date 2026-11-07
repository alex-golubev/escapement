import { HoldTarget, type Id, insertCount, insertNumber, insertOfNumber } from '@escapement/model'
import { Boolean, Option, Record } from 'effect'
import type { TargetedKeyboardEvent } from 'preact'
import { useRef, useState } from 'preact/hooks'
import { useCore } from '../core-context'
import { type TurnScale, useTurnGesture } from './turn-gesture'
import './insert-field.css'

/** By the insert's number, 4 pixels each, a key press one, a double click the master. */
const scale: TurnScale = {
  units: (number) => number,
  value: Math.round,
  range: { minimum: 0, maximum: insertCount },
  pixelsPerUnit: 4,
  step: 1,
  default: 0
}

/** A digit more than the last insert's number has: one past it reads as typed, and is refused, not cut. */
const digits = String(insertCount).length + 1

/** A dash for the master, which no number names; another insert by its number. */
const numberText = (number: number) =>
  Option.match(
    Option.liftPredicate(number, (number) => number > 0),
    { onNone: () => '—', onSome: String }
  )

const whereText = (number: number) =>
  Option.match(
    Option.liftPredicate(number, (number) => number > 0),
    {
      onNone: () => 'the master',
      onSome: (number) => `strip ${number}`
    }
  )

/** A digit typed, not a shortcut with one, such as Cmd+1. */
const typedDigit = ({ key, metaKey, ctrlKey, altKey }: KeyboardEvent) =>
  /^[0-9]$/.test(key) && !metaKey && !ctrlKey && !altKey

/**
 * The mixer's insert a track goes into, as its number, a dash for the master: dragged up or down, or typed while it
 * has the focus and kept with Enter or a click elsewhere, Esc leaving it as it was. While a number is typed, the keys
 * that turn it, and the page's own, leave it be.
 */
export const InsertField = ({
  track,
  owner,
  insert
}: {
  readonly track: Id
  readonly owner: string
  readonly insert: Id
}) => {
  const { turns } = useCore()
  const target = HoldTarget.TrackInsert({ track })
  const turned = useTurnGesture(
    target,
    Option.getOrElse(insertNumber(insert), () => 0),
    scale
  )
  const [typed, setTyped] = useState(Option.none<string>())
  // What is typed by now: keys may come faster than the field is drawn again.
  const typing = useRef(typed)
  const type = (next: (was: Option.Option<string>) => Option.Option<string>) => {
    typing.current = next(typing.current)
    setTyped(typing.current)
  }
  /** What was typed, if it is the number of an insert there is. */
  const keep = () => {
    Option.map(
      Option.filter(
        Option.map(typing.current, (text) => Number.parseInt(text, 10)),
        (number) => Option.isSome(insertOfNumber(number))
      ),
      (number) => turns.set(target, number)
    )
    type(Option.none)
  }
  const typingKeys: Record.ReadonlyRecord<string, () => void> = {
    Enter: keep,
    Escape: () => type(Option.none),
    Backspace: () =>
      type((was) =>
        Option.filter(
          Option.map(was, (text) => text.slice(0, -1)),
          (text) => text.length > 0
        )
      )
  }
  const onKeyDown = (event: TargetedKeyboardEvent<HTMLElement>) =>
    Boolean.match(typedDigit(event), {
      onTrue: () => {
        event.preventDefault()
        type((was) =>
          Option.some(
            Option.match(was, {
              onNone: () => event.key,
              onSome: (text) => `${text}${event.key}`.slice(0, digits)
            })
          )
        )
      },
      onFalse: () =>
        Option.match(typing.current, {
          onNone: () => turned.keys.onKeyDown(event),
          onSome: () =>
            Option.map(Record.get(typingKeys, event.key), (act) => {
              event.preventDefault()
              act()
            })
        })
    })
  const where = whereText(turned.value)
  const said = Option.match(typed, {
    onNone: () => ({
      text: where,
      hint: `${owner} goes into ${where}: in the project. Drag up or down, or type a strip's number and Enter; double-click for the master`
    }),
    onSome: (text) => ({
      text: `typing ${text}`,
      hint: `${owner} goes into strip ${text} once Enter or a click elsewhere keeps it; Esc leaves it as it was`
    })
  })
  return (
    <span
      role='spinbutton'
      class='field num insert-field'
      tabIndex={0}
      aria-label={`${owner}: mixer strip`}
      aria-valuemin={0}
      aria-valuemax={insertCount}
      aria-valuenow={turned.value}
      aria-valuetext={said.text}
      data-typing={Option.isSome(typed)}
      data-hint={said.hint}
      {...turned.pointer}
      onKeyDown={onKeyDown}
      onKeyUp={turned.keys.onKeyUp}
      onBlur={() => {
        keep()
        turned.keys.onBlur()
      }}
    >
      {Option.getOrElse(typed, () => numberText(turned.value))}
    </span>
  )
}
