import { Context, Data, type Effect, type Option, Schema } from 'effect'

export const Taken = Schema.Struct({
  /** When the audio thread hung, in milliseconds of the time of day: the page's own clocks start afresh with it. */
  hangs: Schema.Array(Schema.Finite),
  playing: Schema.Boolean,
  /** As `Restarts` will show them. */
  restarts: Schema.Int,
  /** What the hang said: the reopened page shows it as the last restart's reason. */
  hang: Schema.String
})

/** What the page takes along when it reopens. */
export type Taken = typeof Taken.Type

/** The page couldn't keep what it takes along: without it, it would not know how often it reopened. */
export class CannotReopen extends Data.TaggedError('CannotReopen')<{ readonly cause: unknown }> {}

export interface PageReopen {
  /** What the page took along, if it has just reopened. */
  readonly taken: Option.Option<Taken>
  /** Leaves for `reopenPage`; nothing after this reaches the page. */
  readonly reopen: (taken: Taken) => Effect.Effect<void, CannotReopen>
  /** Whether the page is leaving to reopen: it goes on its own, and asks no one. */
  readonly reopening: () => boolean
}

export const PageReopen = Context.Service<PageReopen>('PageReopen')
