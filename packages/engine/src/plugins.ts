import {
  defaultStrip,
  type ParamId,
  type ParamValues,
  type Plugin,
  type SampleId,
  type SampleSounds,
  type Sha256,
  type StripParamId,
  type StripValues,
  strip
} from '@escapement/engine-description'
import { Command } from './commands'
import { DeviceEdit } from './device-edits'
import type { NodeHandle } from './handles'

/**
 * An entry's place in a list of a description, from 1; never 0, which commands and edits take as none. `owner` names
 * whose list it is.
 */
const placeOf = (owner: string, list: ReadonlyArray<{ readonly id: string }>, id: string, what: string) => {
  const index = list.findIndex((entry) => entry.id === id)
  if (index < 0) throw new Error(`${owner} has no ${what} ${id}`)
  return index + 1
}

/**
 * What commands address a parameter by. An ID the plugin doesn't have throws, which its type keeps out unless the
 * plugin's type is any plugin.
 */
export const paramNumber = <P extends Plugin>(plugin: P, id: ParamId<P>): number =>
  placeOf(plugin.label, plugin.params, id, 'parameter')

/** What edits address a sample by; as with parameters, an ID the plugin doesn't have throws. */
export const sampleNumber = <P extends Plugin>(plugin: P, id: SampleId<P>): number =>
  placeOf(plugin.label, plugin.samples, id, 'sample')

/** What commands address a parameter of a node's strip by; as with a plugin's, an ID the strip doesn't have throws. */
export const stripNumber = (id: StripParamId): number => placeOf('The strip', strip, id, 'parameter')

/** Every parameter of the strip, by its number. */
const stripValues = (values: StripValues) => strip.map(({ id }, index) => ({ param: index + 1, value: values[id] }))

/**
 * Every parameter left out starts at its default, every sample without a sound; an ID the plugin doesn't have throws.
 */
export const createNode = <P extends Plugin>(
  plugin: P,
  node: NodeHandle,
  values: ParamValues<P> = {},
  sounds: SampleSounds<P> = {},
  stripped: StripValues = defaultStrip
) =>
  DeviceEdit.CreateNode({
    node,
    plugin: plugin.id,
    version: plugin.version,
    params: Object.entries<number | undefined>(values).flatMap(([id, value]) =>
      value === undefined ? [] : [{ param: paramNumber(plugin, id as ParamId<P>), value }]
    ),
    samples: Object.entries<Sha256 | undefined>(sounds).flatMap(([id, hash]) =>
      hash === undefined ? [] : [{ sample: sampleNumber(plugin, id as SampleId<P>), hash }]
    ),
    strip: stripValues(stripped)
  })

export const createInsert = (node: NodeHandle, stripped: StripValues = defaultStrip, metered = false) =>
  DeviceEdit.CreateInsert({ node, strip: stripValues(stripped), metered })

export const setParam = <P extends Plugin>(plugin: P, node: NodeHandle, id: ParamId<P>, value: number) =>
  Command.SetParam({ node, param: paramNumber(plugin, id), value })

export const setStripParam = (node: NodeHandle, id: StripParamId, value: number) =>
  Command.SetStripParam({ node, param: stripNumber(id), value })
