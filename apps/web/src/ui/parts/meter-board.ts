import type { Id } from '@escapement/model'
import { Boolean, Brand, Option } from 'effect'
import { createContext } from 'preact'
import type { Frame } from '../../services/engine-host'
import { type Overs, wentOver } from './levels'

/** Whose meter it is on the board: a key of its own, not a name shown. */
export type MeterKey = Brand.Branded<string, 'MeterKey'>

const MeterKey = Brand.nominal<MeterKey>()

/** The master's meter: the engine's output. */
export const masterMeter = MeterKey('master')

/** A track's meter, after its fader: apart from the master's whatever the track's ID. */
export const trackMeter = (track: Id) => MeterKey(`track:${track}`)

export type Side = 0 | 1

const sides: ReadonlyArray<Side> = [0, 1]

/** A meter as a frame reads it: whose, and which node's, as its count of overs is that node's alone. */
interface Reading {
  readonly owner: MeterKey
  /** The master's, or a node's handle. */
  readonly meter: string
  readonly peaks: readonly [number, number]
  readonly overs: readonly [number, number]
}

/**
 * The meters of the mixer, by whose they are, as the engine's board tells them: each frame taken in once, however many
 * meters draw it. A lamp lights when its side's count of blocks over full scale moves, and stays lit until put out,
 * though its strip scrolls out of sight; a frame whose board couldn't be read leaves everything as it was.
 */
export interface MeterBoard {
  readonly follow: (frame: Frame | undefined) => void
  /** 1 is full scale; 0 for a meter not on the board. */
  readonly level: (owner: MeterKey, side: Side) => number
  readonly lit: (owner: MeterKey, side: Side) => boolean
  readonly putOut: (owner: MeterKey, side: Side) => void
}

const lampOf = (owner: MeterKey, side: Side) => `${owner} ${side}`

/** The frame's meters with an owner: the master's, and those of the nodes the compiler names. */
const readingsOf = ({ telemetry, meters }: Frame): Option.Option<ReadonlyArray<Reading>> =>
  Option.map(Option.fromUndefinedOr(telemetry), ({ peaks, overs, meters: records }) => [
    { owner: masterMeter, meter: masterMeter, peaks, overs },
    ...records.flatMap(({ node, peaks, overs }) =>
      Option.toArray(
        Option.map(Option.fromUndefinedOr(meters.get(node)), (track) => ({
          owner: trackMeter(track),
          meter: String(node),
          peaks,
          overs
        }))
      )
    )
  ])

export const meterBoard = (): MeterBoard => {
  const state = {
    followed: Option.none<Frame | undefined>(),
    /** The engine of the last frame taken in. */
    engine: Option.none<number>(),
    levels: new Map<MeterKey, Reading['peaks']>(),
    seen: new Map<string, { readonly engine: number; readonly overs: Reading['overs'] }>(),
    lit: new Set<string>()
  }
  const take = (engine: number, readings: ReadonlyArray<Reading>) => {
    // A node first seen after the board took in its engine is one made since: all it counted is news.
    const madeSince = Option.contains(state.engine, engine)
    state.levels = new Map(readings.map(({ owner, peaks }) => [owner, peaks]))
    readings.forEach(({ owner, meter, overs }) => {
      const before = Option.orElse(Option.fromUndefinedOr(state.seen.get(meter)), () =>
        Option.liftPredicate({ engine, overs: [0, 0] as const }, () => madeSince)
      )
      sides.forEach((side) => {
        const was = Option.map(before, (seen): Overs => ({ engine: seen.engine, count: seen.overs[side] }))
        Boolean.match(wentOver(was, Option.some({ engine, count: overs[side] })), {
          onTrue: () => void state.lit.add(lampOf(owner, side)),
          onFalse: () => {}
        })
      })
    })
    // Only the meters on the board now: the handles of nodes gone never come back.
    state.seen = new Map(readings.map(({ meter, overs }) => [meter, { engine, overs }]))
    state.engine = Option.some(engine)
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
            onSome: (played) => Option.map(readingsOf(played), (readings) => take(played.engine, readings))
          })
        }
      }
    )
  return {
    follow,
    level: (owner, side) =>
      Option.match(Option.fromUndefinedOr(state.levels.get(owner)), {
        onNone: () => 0,
        onSome: (peaks) => peaks[side]
      }),
    lit: (owner, side) => state.lit.has(lampOf(owner, side)),
    putOut: (owner, side) => void state.lit.delete(lampOf(owner, side))
  }
}

/** The page's meters, the master's on the transport and the Mixer's strips: one board, its lamps latched for both. */
export const MeterBoardContext = createContext(meterBoard())
