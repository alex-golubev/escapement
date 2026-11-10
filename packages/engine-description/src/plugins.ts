import { Array, Boolean, Number, Option, Record } from 'effect'
import { plugins, type scales, silenceBelow, strip, type units } from './catalog/descriptions'
import type { Sha256 } from './sounds'

export { plugins, strip }

export type PluginName = keyof typeof plugins
export type Plugin = (typeof plugins)[PluginName]
export type StripParam = (typeof strip)[number]
export type StripParamId = StripParam['id']
/** Every parameter of a strip. */
export type StripValues = Readonly<Record<StripParamId, number>>
export type ParamDescription = Plugin['params'][number]

/** Every parameter of a strip at its default. */
export const defaultStrip = Object.fromEntries(strip.map((param) => [param.id, param.default])) as StripValues
export type ParamId<P extends Plugin> = P['params'][number]['id']
/**
 * By parameter ID; a parameter left out keeps its default. A plugin without parameters takes none: an empty record
 * type would take any key.
 */
export type ParamValues<P extends Plugin> = [ParamId<P>] extends [never]
  ? Readonly<Record<string, never>>
  : Partial<Record<ParamId<P>, number>>
export type SampleId<P extends Plugin> = P['samples'][number]['id']
/** By sample ID; a sample left out has no sound. */
export type SampleSounds<P extends Plugin> = Partial<Record<SampleId<P>, Sha256>>

/** What code calls the plugin a project names by its ID and version; none if this build doesn't have it. */
export const pluginNameOf = (id: number, version: number): Option.Option<PluginName> =>
  Option.fromUndefinedOr(
    Record.keys(plugins).find((name) => plugins[name].id === id && plugins[name].version === version)
  )

// Every one in Rust, used or not: a new one doesn't compile until it is handled here.
type Unit = (typeof units)[number]
type Scale = (typeof scales)[number]

/** Numbers from `min` to `max`: whole ones only, or any. */
export interface Range {
  readonly min: number
  readonly max: number
  readonly whole?: boolean
}

/** A range as `Number.clamp` takes it. */
const inRange = ({ min, max }: Range) => ({ minimum: min, maximum: max })

/** The nearest number in the range, and of a whole one, the nearest whole number. */
export const nearestIn = (range: Range, value: number) =>
  Number.clamp(
    Boolean.match(range.whole === true, { onTrue: () => Math.round(value), onFalse: () => value }),
    inRange(range)
  )

/** What a knob needs of any parameter, whichever units and scales the descriptions use today. */
interface Knob extends Range {
  readonly unit: Unit | null
  readonly scale: Scale
  /** Whole numbers only, such as semitones or a choice's place. */
  readonly whole: boolean
}

/** One of a parameter's choices, stored by its place. */
export interface Choice {
  /** What code calls it, such as the page drawing its picture. */
  readonly id: string
  readonly label: string
}

/** What a control sets: a plugin's parameter, a strip's, or one made from them, such as a track's. */
export interface AnyParam extends Knob {
  readonly id: string
  readonly label: string
  /** The controls it stands with, such as an oscillator's; none for one on its own. */
  readonly group: string | null
  /** In the order projects keep them, the place of each its value; none for a number, which a knob turns. */
  readonly choices: ReadonlyArray<Choice> | null
  readonly default: number
  readonly smoothingSeconds: number
}

/** As a multiplier of the sound: 0 dB leaves it as it is. */
export const gainOf = (decibels: number) => 10 ** (decibels / 20)

/** A new track's volume: 5.2 dB down, so that several sound together with room to spare. */
export const newTrackVolume = gainOf(-5.2)

/** On a volume knob from silence to 0 dB, how far up a new track's volume stands. */
export const newTrackPosition = 0.78

/** So a volume knob up to 0 dB is at a new track's volume where `newTrackPosition` says, and silent at the bottom. */
const volumeExponent = Math.log(newTrackVolume) / Math.log(newTrackPosition)

/** So half way up a time knob is a sixteenth of its range: from 0 to 10 s, 0.625 s. */
const timeExponent = 4

interface ScaleShape {
  readonly value: (knob: Knob, position: number) => number
  readonly position: (knob: Knob, value: number) => number
}

/** Up from the minimum by the position to the power: finer near the bottom the higher the power. */
const powerShape = (exponent: number): ScaleShape => ({
  value: ({ min, max }, position) => min + (max - min) * position ** exponent,
  position: ({ min, max }, value) => ((value - min) / (max - min)) ** (1 / exponent)
})

const scaleShapes: { readonly [S in Scale]: ScaleShape } = {
  linear: {
    value: ({ min, max }, position) => min + (max - min) * position,
    position: ({ min, max }, value) => (value - min) / (max - min)
  },
  logarithmic: {
    value: ({ min, max }, position) => min * (max / min) ** position,
    position: ({ min, max }, value) => Math.log(value / min) / Math.log(max / min)
  },
  volume: powerShape(volumeExponent),
  time: powerShape(timeExponent)
}

const unit = { minimum: 0, maximum: 1 }

/** A knob's position, from 0 to 1, as a value on the parameter's scale. */
export const paramValue = (param: Knob, position: number) =>
  nearestIn(param, scaleShapes[param.scale].value(param, Number.clamp(position, unit)))

/** Where a knob stands for the value. */
export const paramPosition = (param: Knob, value: number) =>
  Number.clamp(scaleShapes[param.scale].position(param, Number.clamp(value, inRange(param))), unit)

/** Signed, with a true minus, and no sign for what rounds to 0. */
const signed = (digits: number) => {
  const format = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    signDisplay: 'exceptZero',
    useGrouping: false
  })
  return (value: number) => format.format(value).replace('-', '−')
}

const tenths = signed(1)
const wholes = signed(0)

/** A multiplier of the sound in decibels; what the engine takes as silence, as silence. */
export const gainText = (gain: number) =>
  Option.match(
    Option.liftPredicate(gain, (heard) => heard >= silenceBelow),
    {
      onNone: () => '−∞ dB',
      onSome: (heard) => `${tenths(20 * Math.log10(heard))} dB`
    }
  )

/** To a tenth, without a trailing zero. */
const toTenth = (value: number) => parseFloat(value.toFixed(1))

/** A number of small units, such as hertz: in them, as `small` writes it, below a thousand, then in thousands. */
const inThousands = (small: string, large: string, written: (value: number) => number) => (value: number) =>
  Boolean.match(Math.round(value) < 1000, {
    onTrue: () => `${written(value)} ${small}`,
    onFalse: () => `${toTenth(value / 1000)} ${large}`
  })

const hertzText = inThousands('Hz', 'kHz', Math.round)

/** Below 10 ms to a tenth, so a delay of a few samples doesn't read as none. */
const millisecondsText = inThousands('ms', 's', (milliseconds) =>
  Boolean.match(milliseconds < 10, { onTrue: () => toTenth(milliseconds), onFalse: () => Math.round(milliseconds) })
)

/** How far a pan is to a side, in whole percent; none where it rounds to the centre. */
const panSide = (pan: number) =>
  Option.map(
    Option.liftPredicate(Math.round(Math.abs(pan) * 100), (percent) => percent > 0),
    (percent) => ({ percent, left: pan < 0 })
  )

type UnitTexts = { readonly [U in Unit]: (value: number) => string }

const unitText: UnitTexts = {
  hertz: hertzText,
  pan: (pan) =>
    Option.match(panSide(pan), {
      onNone: () => 'center',
      onSome: ({ percent, left }) =>
        `${percent}% ${Boolean.match(left, { onTrue: () => 'left', onFalse: () => 'right' })}`
    }),
  gain: (gain) => gainText(gain),
  semitones: (semitones) => `${wholes(semitones)} st`,
  cents: (cents) => `${wholes(cents)} ct`,
  percent: (share) => `${Math.round(share * 100)}%`,
  seconds: (seconds) => millisecondsText(seconds * 1000)
}

/** As a narrow place reads them, such as a track's head: a pan as `C`, `L14` or `R22`. */
const shortText: UnitTexts = {
  ...unitText,
  pan: (pan) =>
    Option.match(panSide(pan), {
      onNone: () => 'C',
      onSome: ({ percent, left }) => `${Boolean.match(left, { onTrue: () => 'L', onFalse: () => 'R' })}${percent}`
    })
}

const formatIn = (texts: UnitTexts) => (param: Knob, value: number) =>
  Option.match(Option.fromNullOr(param.unit), {
    onNone: () => value.toFixed(2),
    onSome: (unit) => texts[unit](value)
  })

/** As people read it. */
export const formatValue = formatIn(unitText)

/** As `formatValue`, but for the few units a narrow place writes shorter. */
export const formatShort = formatIn(shortText)

/** Positions along a knob's travel where `widestText` reads it: fine enough to reach −100.0 dB near a volume's bottom. */
const readings = Array.makeBy(1001, (step) => step / 1000)

/** The most characters a knob's number reads as `format` writes it, anywhere along its travel: read once a knob. */
const widestIn = (format: (param: Knob, value: number) => string) => {
  const widest = new WeakMap<Knob, number>()
  return (param: Knob): number =>
    Option.getOrElse(Option.fromUndefinedOr(widest.get(param)), () => {
      const chars = Math.max(...readings.map((position) => format(param, paramValue(param, position)).length))
      widest.set(param, chars)
      return chars
    })
}

/** What a knob's field holds without moving as it turns. */
export const widestText = widestIn(formatValue)

/** As `widestText`, as `formatShort` writes it. */
export const widestShort = widestIn(formatShort)
