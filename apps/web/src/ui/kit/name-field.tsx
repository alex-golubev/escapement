import { Boolean, Option } from 'effect'
import { useLayoutEffect, useRef } from 'preact/hooks'
import './name-field.css'

const nameLength = 80

interface NameFieldProps {
  readonly name: string
  /** What a screen reader calls it. */
  readonly label: string
  readonly hint: string
  /** Where it stands and how big, as the place it stands in has it. */
  readonly class: string
  /**
   * Once: what was typed, or none for Esc and for the name it opened with, which would write back over a name another
   * client gave since; `focusBack` after a key, as the focus is the field's to give back, and not after a click
   * elsewhere, which took it.
   */
  readonly settled: (typed: Option.Option<string>, focusBack: boolean) => void
}

/** A name changed in place, its text chosen to type over: Enter or a click elsewhere keeps what is typed, Esc doesn't. */
export const NameField = ({ name, label, hint, class: place, settled }: NameFieldProps) => {
  const field = useRef<HTMLInputElement>(null)
  // Enter or Esc settles it before the field goes: the blur the browser sends as it goes then changes nothing.
  const done = useRef(false)
  const opened = useRef(name)
  useLayoutEffect(() => {
    field.current?.focus()
    field.current?.select()
  }, [])
  const settle = (keep: boolean, focusBack: boolean) =>
    Boolean.match(done.current, {
      onTrue: () => {},
      onFalse: () => {
        done.current = true
        settled(
          Option.filter(Option.some(field.current?.value ?? name), (typed) => keep && typed !== opened.current),
          focusBack
        )
      }
    })
  const keys: Record<string, () => void> = {
    Enter: () => settle(true, true),
    Escape: () => settle(false, true)
  }
  // Enter that picks a word from an input method is the method's.
  const keyDown = (event: KeyboardEvent) =>
    Option.match(
      Option.filter(Option.fromNullishOr(keys[event.key]), () => !event.isComposing),
      {
        onNone: () => {},
        onSome: (settles) => {
          event.preventDefault()
          settles()
        }
      }
    )
  // The window going to another tab or app takes the focus too: back to it, the field has it again.
  const blurred = () => Boolean.match(document.hasFocus(), { onTrue: () => settle(true, false), onFalse: () => {} })
  return (
    <input
      ref={field}
      class={`name-field ${place}`}
      type='text'
      defaultValue={name}
      maxLength={nameLength}
      spellcheck={false}
      aria-label={label}
      data-hint={hint}
      onBlur={blurred}
      onKeyDown={keyDown}
    />
  )
}
