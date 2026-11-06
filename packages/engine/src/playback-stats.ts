import { Option } from 'effect'

/** Gaps in the sound since the context was created. */
export interface PlaybackStats {
  readonly underrunEvents: number
  /** Seconds. */
  readonly underrunDuration: number
}

/** An AudioContext as Chrome 146+ makes it: `playbackStats` is not in TypeScript's DOM types. */
export interface WithPlaybackStats {
  readonly playbackStats?: unknown
}

// The fields are checked in case a build names them differently.
const isPlaybackStats = (value: unknown): value is PlaybackStats =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Partial<PlaybackStats>).underrunEvents === 'number' &&
  typeof (value as Partial<PlaybackStats>).underrunDuration === 'number'

/**
 * The context's live object, updated once a second while the context runs and the page is visible: the spec's guard
 * against sites signalling through glitches.
 */
export const playbackStatsOf = ({ playbackStats }: WithPlaybackStats): Option.Option<PlaybackStats> =>
  Option.liftPredicate(playbackStats, isPlaybackStats)
