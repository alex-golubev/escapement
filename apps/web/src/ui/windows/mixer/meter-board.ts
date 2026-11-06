import type { MeterReading } from '@escapement/engine'
import { Boolean, Option } from 'effect'
import type { Frame } from '../../../services/engine-host'
import { type Overs, wentOver } from '../../parts/levels'

/** The master's meter, beside the strips' by their numbers from 1. */
export const masterMeter = 0

export type Side = 0 | 1

const sides: ReadonlyArray<Side> = [0, 1]

/**
 * The meters of the mixer, by number, as the engine's board tells them: each frame taken in once, however many meters
 * draw it. A lamp lights when its side's count of blocks over full scale moves, and stays lit until put out, though
 * its strip scrolls out of sight; a frame whose board couldn't be read leaves everything as it was.
 */
export interface MeterBoard {
  readonly follow: (frame: Frame | undefined) => void
  /** 1 is full scale; 0 for a meter not on the board. */
  readonly level: (meter: number, side: Side) => number
  readonly lit: (meter: number, side: Side) => boolean
  readonly putOut: (meter: number, side: Side) => void
}

const lampOf = (meter: number, side: Side) => `${meter} ${side}`

export const meterBoard = (): MeterBoard => {
  const state = {
    followed: Option.none<Frame | undefined>(),
    levels: new Map<number, MeterReading['peaks']>(),
    seen: new Map<number, { readonly engine: number; readonly overs: MeterReading['overs'] }>(),
    lit: new Set<string>()
  }
  const take = (engine: number, readings: ReadonlyArray<MeterReading>) => {
    state.levels = new Map(readings.map(({ meter, peaks }) => [meter, peaks]))
    readings.forEach(({ meter, overs }) => {
      const before = Option.fromUndefinedOr(state.seen.get(meter))
      sides.forEach((side) => {
        const was = Option.map(before, (seen): Overs => ({ engine: seen.engine, count: seen.overs[side] }))
        Boolean.match(wentOver(was, Option.some({ engine, count: overs[side] })), {
          onTrue: () => void state.lit.add(lampOf(meter, side)),
          onFalse: () => {}
        })
      })
      state.seen.set(meter, { engine, overs })
    })
  }
  const follow = (frame: Frame | undefined) =>
    Boolean.match(
      Option.exists(state.followed, (followed) => followed === frame),
      {
        onTrue: () => {},
        onFalse: () => {
          state.followed = Option.some(frame)
          Option.match(Option.fromUndefinedOr(frame), {
            // No engine plays.
            onNone: () => {
              state.levels = new Map()
            },
            onSome: ({ engine, telemetry }) =>
              Option.map(Option.fromUndefinedOr(telemetry), ({ peaks, overs, meters }) =>
                take(engine, [{ meter: masterMeter, peaks, overs }, ...meters])
              )
          })
        }
      }
    )
  return {
    follow,
    level: (meter, side) =>
      Option.match(Option.fromUndefinedOr(state.levels.get(meter)), {
        onNone: () => 0,
        onSome: (peaks) => peaks[side]
      }),
    lit: (meter, side) => state.lit.has(lampOf(meter, side)),
    putOut: (meter, side) => void state.lit.delete(lampOf(meter, side))
  }
}
