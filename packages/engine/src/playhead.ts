import { ticksPerQuarter } from '@escapement/engine-description'
import { Boolean, Option } from 'effect'
import type { Telemetry } from './telemetry'

/** A read of the board: where the transport was at a frame of the context. */
export type Snapshot = Pick<Telemetry, 'frame' | 'playing' | 'position' | 'loopTicks' | 'tempo'>

/** The context's frame heard at `now`, a `performance.now()`; none until the output starts. */
export const heardFrame = (
  context: Pick<AudioContext, 'getOutputTimestamp' | 'currentTime' | 'sampleRate'>,
  now: number
): Option.Option<number> => {
  const { contextTime = 0, performanceTime = 0 } = context.getOutputTimestamp()
  return Option.map(
    Option.liftPredicate(performanceTime, (started) => started !== 0),
    // Never past what is rendered, should the output stall.
    (started) => Math.min(contextTime + (now - started) / 1000, context.currentTime) * context.sampleRate
  )
}

/** The newest snapshot heard at `heardFrame` and all after it, `read` among them unless its block is in already. */
export const keepAudible = (
  snapshots: ReadonlyArray<Snapshot>,
  read: Snapshot,
  heardFrame: number
): ReadonlyArray<Snapshot> => {
  const all = Boolean.match(read.frame === snapshots.at(-1)?.frame, {
    onTrue: () => snapshots,
    onFalse: () => [...snapshots, read]
  })
  const heard = all.findLastIndex(({ frame }) => frame <= heardFrame)
  return Boolean.match(heard > 0, { onTrue: () => all.slice(heard), onFalse: () => all })
}

/** Where the transport is heard: its tick, the loop it goes round in, its tempo, and whether it plays. */
export interface Heard {
  /** Stopped, where it stands. */
  readonly tick: number
  /** 0 while stopped. */
  readonly loop: number
  readonly tempo: number
  readonly playing: boolean
}

/** Heard at `heardFrame`, by the snapshot heard then: playing, counted on in its loop; stopped, where it stands. */
export const heardTick = (
  snapshots: ReadonlyArray<Snapshot>,
  heardFrame: number,
  sampleRate: number
): Option.Option<Heard> =>
  Option.map(
    Option.fromUndefinedOr(snapshots.findLast(({ frame }) => frame <= heardFrame)),
    ({ playing, tempo, position, loopTicks, frame }) => ({
      tick: Boolean.match(playing, {
        onTrue: () => (position + ((heardFrame - frame) * tempo * ticksPerQuarter) / (60 * sampleRate)) % loopTicks,
        onFalse: () => position
      }),
      loop: loopTicks,
      tempo,
      playing
    })
  )

/**
 * Where the transport is heard now, read on every frame from the latest snapshot, if any: the snapshots it may still
 * need are kept from frame to frame. None until the output starts, and while `heardTick` gives none.
 */
export const heardTickReader = (context: Pick<AudioContext, 'getOutputTimestamp' | 'currentTime' | 'sampleRate'>) => {
  const heard: { snapshots: ReadonlyArray<Snapshot> } = { snapshots: [] }
  return (read: Snapshot | undefined, now: number): Option.Option<Heard> =>
    Option.flatMap(heardFrame(context, now), (frame) => {
      heard.snapshots = Option.match(Option.fromUndefinedOr(read), {
        onNone: () => heard.snapshots,
        onSome: (read) => keepAudible(heard.snapshots, read, frame)
      })
      return heardTick(heard.snapshots, frame, context.sampleRate)
    })
}
