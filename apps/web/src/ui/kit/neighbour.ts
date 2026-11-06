import { Array, Option } from 'effect'

/** What `selector` finds in the row after `row`, or else in the one before it: where the focus goes as `row` does. */
export const neighbourOf = (row: Element | null, selector: string) =>
  Option.flatMap(Option.fromNullishOr(row), (row) =>
    Array.findFirst([row.nextElementSibling, row.previousElementSibling], (sibling) =>
      Option.fromNullishOr(sibling?.querySelector<HTMLElement>(selector))
    )
  )
