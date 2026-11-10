import { Array, Boolean, Brand, Option, Schema } from 'effect'

/** A colour as a project holds it: `#rrggbb`, in lower case. Every shade drawn of it comes from it alone. */
export type Colour = Brand.Branded<string, 'Colour'>

export const Colour = Brand.make<Colour>((hex) => /^#[0-9a-f]{6}$/.test(hex) || `not a colour as #rrggbb: ${hex}`)

/** A colour as a document or another client holds it, read as anything. */
export const storedColour = Schema.String.pipe(Schema.fromBrand('Colour', Colour))

/** A colour the menu offers a track, by its name there. */
export interface NamedColour {
  readonly name: string
  readonly colour: Colour
}

/** What tracks are given round, muted and dark, none like amber, red or a meter's: a track may hold any other too. */
export const trackColours: Array.NonEmptyReadonlyArray<NamedColour> = [
  { name: 'Teal', colour: Colour('#2b5357') },
  { name: 'Indigo', colour: Colour('#3b4363') },
  { name: 'Rust', colour: Colour('#634433') },
  { name: 'Olive', colour: Colour('#455038') },
  { name: 'Plum', colour: Colour('#55335b') },
  { name: 'Ochre', colour: Colour('#5b4f33') },
  { name: 'Steel', colour: Colour('#2e4d6b') },
  { name: 'Wine', colour: Colour('#5b333d') }
]

/** A track's colour where it holds none, or one reading can't take. */
export const firstColour = Array.headNonEmpty(trackColours).colour

/** The palette's colour after this one, round to the first; the first after none, or after one not in the palette. */
const colourAfter = (colour: Option.Option<Colour>): Colour => {
  const next = Option.match(
    Option.flatMap(colour, (before) => Array.findFirstIndex(trackColours, (named) => named.colour === before)),
    { onNone: () => 0, onSome: (at) => (at + 1) % trackColours.length }
  )
  return Option.getOrElse(Array.get(trackColours, next), () => Array.headNonEmpty(trackColours)).colour
}

/** The palette's colour after `after`'s, or the one after that where it is `beside`'s: like neither neighbour's. */
export const colourBetween = (after: Option.Option<Colour>, beside: Option.Option<Colour>): Colour => {
  const next = colourAfter(after)
  return Boolean.match(Option.contains(beside, next), {
    onTrue: () => colourAfter(Option.some(next)),
    onFalse: () => next
  })
}
