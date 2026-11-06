import { ticksPerQuarter } from '@escapement/engine-description'
import { Boolean, Option } from 'effect'
import type { Telemetry } from './telemetry'

/** A read of the board: where the transport was at a frame of the context. */
export type Snapshot = Pick<Telemetry, 'frame' | 'playing' | 'position' | 'loopTicks' | 'arrangement' | 'tempo'>

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

/** Where the transport is heard: the tick, the loop it goes round in, and whether the loop plays the arrangement. */
export interface Heard {
  readonly tick: number
  readonly loop: number
  readonly arrangement: boolean
}

/**
 * Where the transport is heard at `heardFrame`, from the snapshot heard then at its own tempo, within its own loop. None
 * while what is heard was rendered stopped or before every snapshot.
 */
export const heardTick = (
  snapshots: ReadonlyArray<Snapshot>,
  heardFrame: number,
  sampleRate: number
): Option.Option<Heard> =>
  Option.fromUndefinedOr(snapshots.findLast(({ frame }) => frame <= heardFrame)).pipe(
    Option.filter(({ playing }) => playing),
    Option.map(({ tempo, position, loopTicks, arrangement, frame }) => {
      const ticksPerFrame = (tempo * ticksPerQuarter) / (60 * sampleRate)
      return { tick: (position + (heardFrame - frame) * ticksPerFrame) % loopTicks, loop: loopTicks, arrangement }
    })
  )

/**
 * The tick heard now, read on every frame from the latest snapshot, if any: the snapshots it may still need are kept
 * from frame to frame. None until the output starts, and while `heardTick` gives none.
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
