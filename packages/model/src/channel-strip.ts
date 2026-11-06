import {
  type AnyParam,
  defaultStrip,
  newChannelPosition,
  paramValue,
  type StripParamId,
  type StripValues,
  strip
} from '@escapement/engine-description'
import { Option } from 'effect'

/** Where a channel's knob ends, inside the engine's range: its volume no higher than the sound as it is. */
const channelEnds: { readonly [P in StripParamId]: Partial<Pick<AnyParam, 'min' | 'max'>> } = {
  volume: { max: 1 },
  pan: {}
}

const ranged = strip.map((param) => ({ ...param, ...channelEnds[param.id] }))

const volume = Option.getOrThrow(Option.fromUndefinedOr(ranged.find(({ id }) => id === 'volume')))

/** Every parameter of a channel's strip at its default: the volume 5.2 dB down. */
export const defaultChannelStrip: StripValues = { ...defaultStrip, volume: paramValue(volume, newChannelPosition) }

/** A channel's volume and pan: the engine's strip, in a channel's range, at a channel's defaults. */
export const channelStrip: ReadonlyArray<AnyParam & { readonly id: StripParamId }> = ranged.map((param) => ({
  ...param,
  default: defaultChannelStrip[param.id]
}))
