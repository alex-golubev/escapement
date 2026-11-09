import { Array, Option } from 'effect'

/** What `selector` finds in the row after `row`, or else in the one before it: where the focus goes as `row` does. */
export const neighbourOf = (row: Element | null, selector: string) =>
  Option.flatMap(Option.fromNullishOr(row), (row) =>
    Array.findFirst([row.nextElementSibling, row.previousElementSibling], (sibling) =>
      Option.fromNullishOr(sibling?.querySelector<HTMLElement>(selector))
    )
  )

/** The row going with the focus in it, while its DOM is there: the focus to `selector` beside it, or else `orElse`. */
export const focusPast = (
  row: HTMLElement | null,
  selector: string,
  orElse: (going: HTMLElement) => HTMLElement | null | undefined
) =>
  Option.map(
    Option.filter(Option.fromNullishOr(row), (going) => going.contains(document.activeElement)),
    (going) =>
      Option.map(
        Option.orElse(neighbourOf(going, selector), () => Option.fromNullishOr(orElse(going))),
        (next) => next.focus()
      )
  )
