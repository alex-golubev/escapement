/** Drawn with the stroke of the control they stand in. */
export const TrashIcon = () => (
  <svg viewBox='0 0 12 12' aria-hidden='true'>
    <path d='M2 3.5h8' />
    <path d='M4.75 3.5V2h2.5v1.5' />
    <path d='m3 3.5.6 6.5h4.8L9 3.5' />
  </svg>
)

export const PencilIcon = () => (
  <svg viewBox='0 0 12 12' aria-hidden='true'>
    <path d='M8 2.2 9.8 4 4.2 9.6 2 10l.4-2.2z' />
  </svg>
)

/** A sheet over another: a copy. */
export const CopyIcon = () => (
  <svg viewBox='0 0 12 12' aria-hidden='true'>
    <rect x='4.5' y='4.5' width='5.5' height='5.5' rx='0.5' />
    <path d='M7.5 4.5V2H2v5.5h2.5' />
  </svg>
)

/** Notes at three heights, as a piano roll draws them. */
export const NotesIcon = () => (
  <svg viewBox='0 0 12 12' aria-hidden='true'>
    <path d='M1.5 3h4' />
    <path d='M4.5 6h6' />
    <path d='M2.5 9h3.5' />
  </svg>
)

/** A mark by the one chosen. */
export const CheckIcon = () => (
  <svg viewBox='0 0 12 12' aria-hidden='true'>
    <path d='M2.5 6.2 5 8.5l4.5-5' />
  </svg>
)

/** Room of a mark's size beside one not chosen, so the names line up. */
export const BlankIcon = () => <svg viewBox='0 0 12 12' aria-hidden='true' />

/** A list opens under it. */
export const ChevronIcon = () => (
  <svg viewBox='0 0 12 12' aria-hidden='true'>
    <path d='M3.5 4.75 6 7.25l2.5-2.5' />
  </svg>
)
