import type { AnyParam, Choice } from '@escapement/engine-description'
import type { HoldTarget } from '@escapement/model'
import { Array, Boolean, Option, Record } from 'effect'
import type { TargetedKeyboardEvent } from 'preact'
import { useRef } from 'preact/hooks'
import { useCore } from '../core-context'
import './choices.css'

/** One period across 16 by 10, from its middle: a picture of each wave a choice's ID names. */
const pictures: Record.ReadonlyRecord<string, string> = {
  sine: `M${Array.makeBy(33, (i) => `${i / 2} ${(5 - 4 * Math.sin((Math.PI * i) / 16)).toFixed(2)}`).join(' L')}`,
  triangle: 'M0 5 L4 1 L12 9 L16 5',
  square: 'M0 9 V1 H8 V9 H16 V1',
  saw: 'M0 5 L8 1 V9 L16 5',
  noise: 'M0 5 L1.5 2 L3 7 L4.5 3.5 L6 8.5 L7.5 1.5 L9 6.5 L10.5 3 L12 8 L13.5 2.5 L15 6 L16 4.5'
}

/** Arrows choose the next one or the one before, round from the last to the first, as in a radio group. */
const keyMoves: Record.ReadonlyRecord<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }

const ChoiceButton = ({
  owner,
  param,
  choice,
  chosen,
  onChoose
}: {
  readonly owner: string
  readonly param: AnyParam
  readonly choice: Choice
  readonly chosen: boolean
  readonly onChoose: () => void
}) => {
  const what = `${owner} ${param.label.toLowerCase()}`
  const which = choice.label.toLowerCase()
  return (
    <button
      type='button'
      class='toggle toggle--shared choice'
      role='radio'
      aria-checked={chosen}
      aria-label={choice.label}
      // One stop for Tab: the chosen one, as in a radio group.
      tabIndex={Boolean.match(chosen, { onTrue: () => 0, onFalse: () => -1 })}
      data-hint={Boolean.match(chosen, {
        onTrue: () => `${what}: ${which} in the project`,
        onFalse: () => `${what}: choose ${which} in the project`
      })}
      onClick={onChoose}
    >
      {Option.match(Record.get(pictures, choice.id), {
        onNone: () => choice.label,
        onSome: (path) => (
          <svg viewBox='0 0 16 10' aria-hidden='true'>
            <path d={path} />
          </svg>
        )
      })}
    </button>
  )
}

/**
 * A parameter's choices as a row of buttons over its name, the chosen one filled: a click or an arrow writes it into
 * the document at once, a step of undo of its own. `value` is the chosen one's place, as the document reads it.
 */
export const Choices = ({
  owner,
  param,
  choices,
  value,
  target
}: {
  readonly owner: string
  readonly param: AnyParam
  readonly choices: ReadonlyArray<Choice>
  readonly value: number
  readonly target: HoldTarget
}) => {
  const { turns } = useCore()
  const row = useRef<HTMLSpanElement>(null)
  const choose = (place: number) => turns.set(target, place)
  const onKeyDown = (event: TargetedKeyboardEvent<HTMLSpanElement>) =>
    Option.map(Record.get(keyMoves, event.key), (move) => {
      event.preventDefault()
      // Held down, it chooses once rather than running round: each choice is a step of undo.
      Option.map(
        Option.liftPredicate(move, () => !event.repeat),
        (move) => {
          const next = (value + move + choices.length) % choices.length
          choose(next)
          Option.map(Option.fromNullOr(row.current?.children.item(next)), (button) => (button as HTMLElement).focus())
        }
      )
    })
  return (
    <span class='choices'>
      <span ref={row} class='choices__row' role='radiogroup' aria-label={param.label} onKeyDown={onKeyDown}>
        {choices.map((choice, place) => (
          <ChoiceButton
            key={choice.id}
            owner={owner}
            param={param}
            choice={choice}
            chosen={place === value}
            onChoose={() => choose(place)}
          />
        ))}
      </span>
      <span class='cap'>{param.label}</span>
    </span>
  )
}
