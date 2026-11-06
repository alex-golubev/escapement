import { type ParamId, type Plugin, plugins, type StripParamId, strip } from '@escapement/engine-description'
import { Boolean, Data, Equal, Option, Schema } from 'effect'
import { type Id, storedId } from './id'

/** What a control this client turns sets. */
export type HoldTarget = Data.TaggedEnum<{
  /** A parameter of the channel's instrument. */
  ChannelParam: { readonly channel: Id; readonly param: ParamId<Plugin> }
  /** A parameter of the channel's strip: its volume or pan. */
  ChannelStrip: { readonly channel: Id; readonly param: StripParamId }
  /** A parameter of a plugin on the master insert. */
  SlotParam: { readonly slot: Id; readonly param: ParamId<Plugin> }
  /** A parameter of an insert's strip, the master's too: its volume or pan. */
  InsertStrip: { readonly insert: Id; readonly param: StripParamId }
  /** The insert the channel goes into, by its number: 0 the master. */
  ChannelInsert: { readonly channel: Id }
  Tempo: {}
}>

export const HoldTarget = Data.taggedEnum<HoldTarget>()

export interface Hold {
  readonly target: HoldTarget
  readonly value: number
}

/**
 * The values this client holds while it turns controls, its own and never in the document: each plays over the
 * document's until it is let go. Two fingers may turn two at once.
 */
export type Holds = ReadonlyArray<Hold>

export const noHolds: Holds = []

export const heldValue = (holds: Holds, target: HoldTarget): Option.Option<number> =>
  Option.map(Option.fromUndefinedOr(holds.find((hold) => Equal.equals(hold.target, target))), ({ value }) => value)

export const holding = (holds: Holds, target: HoldTarget, value: number): Holds => [
  ...holds.filter((hold) => !Equal.equals(hold.target, target)),
  { target, value }
]

export const lettingGo = (holds: Holds, target: HoldTarget): Holds =>
  holds.filter((hold) => !Equal.equals(hold.target, target))

/** `own` over `others`: theirs count only for the controls `own` doesn't hold, and of theirs for one, the first. */
export const heldOver = (own: Holds, others: Holds): Holds =>
  others.reduce<Holds>(
    (held, hold) =>
      Boolean.match(
        held.some(({ target }) => Equal.equals(target, hold.target)),
        { onTrue: () => held, onFalse: () => [...held, hold] }
      ),
    own
  )

const param = Schema.Literals(Object.values(plugins).flatMap(({ params }) => params.map(({ id }) => id)))
const stripParam = Schema.Literals(strip.map(({ id }) => id))
const heldTarget = Schema.TaggedUnion({
  ChannelParam: { channel: storedId, param },
  ChannelStrip: { channel: storedId, param: stripParam },
  SlotParam: { slot: storedId, param },
  InsertStrip: { insert: storedId, param: stripParam },
  ChannelInsert: { channel: storedId },
  Tempo: {}
})
const hold = Schema.decodeUnknownOption(Schema.Struct({ target: heldTarget, value: Schema.Finite }))

const targetOf = (target: typeof heldTarget.Type): HoldTarget =>
  heldTarget.match(target, {
    ChannelParam: ({ channel, param }) => HoldTarget.ChannelParam({ channel, param }),
    ChannelStrip: ({ channel, param }) => HoldTarget.ChannelStrip({ channel, param }),
    SlotParam: ({ slot, param }) => HoldTarget.SlotParam({ slot, param }),
    InsertStrip: ({ insert, param }) => HoldTarget.InsertStrip({ insert, param }),
    ChannelInsert: ({ channel }) => HoldTarget.ChannelInsert({ channel }),
    Tempo: () => HoldTarget.Tempo()
  })

/** Anything but a list is no holds. */
const entries = (found: unknown): ReadonlyArray<unknown> =>
  Option.getOrElse(Option.liftPredicate(found, Array.isArray), () => [])

/**
 * The holds another client tells of, read as anything, since other clients, other versions and bugs send them: one
 * that isn't a hold of a control some plugin or the strip has, or of the tempo, with a number, is left out; of two for
 * one control, the first. Whatever plays them puts their values into range, as it does this client's.
 */
export const readHolds = (found: unknown): Holds =>
  heldOver(
    noHolds,
    entries(found).flatMap((entry) =>
      Option.toArray(Option.map(hold(entry), ({ target, value }) => ({ target: targetOf(target), value })))
    )
  )
