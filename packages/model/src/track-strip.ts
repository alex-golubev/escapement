import {
  type AnyParam,
  defaultStrip,
  newTrackPosition,
  paramValue,
  type StripParamId,
  type StripValues,
  strip
} from '@escapement/engine-description'
import { Option } from 'effect'

/** Where a track's knob ends, inside the engine's range: its volume no higher than the sound as it is. */
const trackEnds: { readonly [P in StripParamId]: Partial<Pick<AnyParam, 'min' | 'max'>> } = {
  volume: { max: 1 },
  pan: {}
}

const ranged = strip.map((param) => ({ ...param, ...trackEnds[param.id] }))

const volume = Option.getOrThrow(Option.fromUndefinedOr(ranged.find(({ id }) => id === 'volume')))

/** Every parameter of a track's strip at its default: the volume 5.2 dB down. */
export const defaultTrackStrip: StripValues = { ...defaultStrip, volume: paramValue(volume, newTrackPosition) }

/** A track's volume and pan: the engine's strip, in a track's range, at a track's defaults. */
export const trackStrip: ReadonlyArray<AnyParam & { readonly id: StripParamId }> = ranged.map((param) => ({
  ...param,
  default: defaultTrackStrip[param.id]
}))
