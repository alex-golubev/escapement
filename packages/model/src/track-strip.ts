import {
  type AnyParam,
  defaultStrip,
  newTrackVolume,
  type StripParamId,
  type StripValues,
  strip
} from '@escapement/engine-description'

/** Every parameter of a track's strip at its default: the volume 5.2 dB down. */
export const defaultTrackStrip: StripValues = { ...defaultStrip, volume: newTrackVolume }

/** A track's volume and pan: the engine's strip, as its fader in the mixer has it, at a track's defaults. */
export const trackStrip: ReadonlyArray<AnyParam & { readonly id: StripParamId }> = strip.map((param) => ({
  ...param,
  default: defaultTrackStrip[param.id]
}))
