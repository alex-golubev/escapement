import { type Holds, HoldTarget, holding, lettingGo } from '@escapement/model'
import { Array, Boolean, Context, Effect, Equal, FiberSet, Layer, Option } from 'effect'
import { type Atom, AtomRegistry } from 'effect/reactivity'
import { DomainOps } from './domain-ops'
import { ProjectSession } from './session'

/** A control turned from its press to its release. */
export interface Turn {
  /** Plays the value at once; the document gets the last one on release. */
  readonly move: (value: number) => void
  /** Writes the last value to the document, lets go and ends the action; once. */
  readonly release: () => void
}

export interface Turns {
  /**
   * Turns the control from its value now until released, ending a turn of it still going: an action of the undo
   * history, one step, and undo does nothing meanwhile. Its first move holds it: it plays over the document's from then
   * on. Only its last value goes into the document, since undo keeps every value a step replaced; a turn that never
   * moved writes nothing.
   */
  readonly begin: (target: HoldTarget, value: number) => Turn
  /** A double click, or a choice: ends a turn of the control, then into the document at once, a step of undo on its own. */
  readonly set: (target: HoldTarget, value: number) => void
}

export const Turns = Context.Service<Turns>('Turns')

/** A turn going on, and its control. */
interface Turning {
  readonly target: HoldTarget
  readonly turn: Turn
}

/** Turns through the operations, holding values in `holds`. */
export const turnsOf = Effect.fnUntraced(function* (ops: DomainOps, holds: Atom.Writable<Holds>) {
  const registry = yield* AtomRegistry.AtomRegistry
  // What a release does happens at once; a bug in it is logged, and the turn still lets go and ends.
  const run = yield* FiberSet.makeRuntime<never>()
  /** One a control at a time: a second would let go of the first's hold. */
  const turning: { active: ReadonlyArray<Turning> } = { active: [] }
  const write = (target: HoldTarget, value: number) =>
    HoldTarget.$match(target, {
      TrackParam: ({ track, param }) => ops.setTrackParam(track, param, value),
      TrackStrip: ({ track, param }) => ops.setTrackStrip(track, param, value),
      SlotParam: ({ slot, param }) => ops.setMasterParam(slot, param, value),
      MasterStrip: ({ param }) => ops.setMasterStrip(param, value),
      Tempo: () => ops.setTempo(value)
    })
  const releaseTurnOf = (target: HoldTarget) =>
    Option.map(
      Array.findFirst(turning.active, (active) => Equal.equals(active.target, target)),
      ({ turn }) => turn.release()
    )
  const turns: Turns = {
    begin: (target, start) => {
      releaseTurnOf(target)
      const end = ops.begin()
      /** Its last value, whether it moved, whether it was let go. */
      const state = { value: start, moved: false, released: false }
      const turn: Turn = {
        move: (next) =>
          Boolean.match(!state.released && next !== state.value, {
            onTrue: () => {
              state.value = next
              state.moved = true
              registry.update(holds, (held) => holding(held, target, next))
            },
            onFalse: () => {}
          }),
        release: () =>
          Boolean.match(state.released, {
            onTrue: () => {},
            onFalse: () => {
              state.released = true
              turning.active = turning.active.filter((active) => active.turn !== turn)
              // A press alone writes nothing: what others changed meanwhile stays.
              const moved = Effect.succeed(state.moved)
              run(
                // Into the document before the hold goes, so the engine never hears the older value between.
                Effect.sync(() => write(target, state.value)).pipe(
                  Effect.when(moved),
                  Effect.ensuring(
                    Effect.sync(() => registry.update(holds, (held) => lettingGo(held, target))).pipe(
                      Effect.when(moved)
                    )
                  ),
                  Effect.ensuring(Effect.sync(end)),
                  Effect.tapCause(Effect.logError)
                )
              )
            }
          })
      }
      turning.active = [...turning.active, { target, turn }]
      return turn
    },
    set: (target, value) => {
      releaseTurnOf(target)
      run(Effect.sync(() => write(target, value)).pipe(Effect.tapCause(Effect.logError)))
    }
  }
  return turns
})

export const turnsLayer = Layer.effect(
  Turns,
  Effect.gen(function* () {
    const { holds } = yield* ProjectSession
    return yield* turnsOf(yield* DomainOps, holds)
  })
)
