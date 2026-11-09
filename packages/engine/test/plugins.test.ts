import { type Plugin, plugins, strip } from '@escapement/engine-description'
import { expect, test } from 'vitest'
import { Command } from '../src/commands'
import { DeviceEdit } from '../src/device-edits'
import { NodeHandle } from '../src/handles'
import { createInsert, createNode, paramNumber, setParam, setStripParam, stripNumber } from '../src/plugins'
import { live, rejected, startEngine } from './harness'

const node = NodeHandle(1)

/** The strip as a new node gets it: every parameter at its default. */
const defaultValues = [
  { param: 1, value: 1 },
  { param: 2, value: 0 }
]

test('a parameter is numbered by its place in the description, from 1', () => {
  expect(paramNumber(plugins.tone, 'volume')).toBe(1)
  expect(paramNumber(plugins.filter, 'cutoff')).toBe(1)
})

test("an ID the plugin doesn't have doesn't compile, and throws when the plugin's type is any plugin", () => {
  // @ts-expect-error A typo.
  expect(() => paramNumber(plugins.filter, 'cutof')).toThrow('Filter has no parameter cutof')
  // @ts-expect-error Another plugin's ID.
  expect(() => paramNumber(plugins.filter, 'volume')).toThrow('Filter has no parameter volume')
  // A function's result, so the type doesn't narrow to the tone.
  const anyPlugin = ((plugin: Plugin) => plugin)(plugins.tone)
  expect(() => setParam(anyPlugin, node, 'cutoff', 1)).toThrow('Test tone has no parameter cutoff')
  expect(() => createNode(anyPlugin, node, { cutoff: 1 })).toThrow('Test tone has no parameter cutoff')
})

test('a node takes the values it is given by ID; the rest stay at their defaults', () => {
  expect(createNode(plugins.filter, node, { cutoff: 200 })).toEqual(
    DeviceEdit.CreateNode({
      node,
      plugin: 2,
      version: 1,
      params: [{ param: 1, value: 200 }],
      samples: [],
      strip: defaultValues
    })
  )
  expect(createNode(plugins.tone, node, { volume: undefined })).toEqual(
    DeviceEdit.CreateNode({ node, plugin: 1, version: 1, params: [], samples: [], strip: defaultValues })
  )
  expect(setParam(plugins.tone, node, 'volume', 0.3)).toEqual(Command.SetParam({ node, param: 1, value: 0.3 }))
})

test("a strip's parameter is numbered by its place in the strip, and every one goes with a node it is made with", () => {
  expect(strip.map(({ id }) => stripNumber(id))).toEqual([1, 2])
  // A function's result, so the type doesn't keep it out.
  const anyId = ((id: string) => id as 'pan')('cutoff')
  expect(() => stripNumber(anyId)).toThrow('The strip has no parameter cutoff')
  expect(setStripParam(node, 'pan', -0.5)).toEqual(Command.SetStripParam({ node, param: 2, value: -0.5 }))
  const values = { volume: 0.5, pan: 0.25 }
  const sent = [
    { param: 1, value: 0.5 },
    { param: 2, value: 0.25 }
  ]
  expect(createInsert(node)).toEqual(DeviceEdit.CreateInsert({ node, strip: defaultValues, metered: false }))
  expect(createInsert(node, values, true)).toEqual(DeviceEdit.CreateInsert({ node, strip: sent, metered: true }))
  expect(createNode(plugins.tone, node, {}, {}, values)).toEqual(
    DeviceEdit.CreateNode({ node, plugin: 1, version: 1, params: [], samples: [], strip: sent })
  )
})

test('the engine takes every parameter of the strip by its number, and none past them', () => {
  const engine = startEngine({ initial: { edits: [createNode(plugins.tone, node), DeviceEdit.SetOutput({ node })] } })
  const commands = strip.map((param) => setStripParam(node, param.id, param.max))
  engine.send(live(...commands, Command.SetStripParam({ node, param: strip.length + 1, value: 0 })))
  engine.peak()
  expect(engine.readEvents()).toEqual([rejected('UnknownTarget')])
})

test.each(Object.values(plugins))(
  'the engine takes every parameter of $label by its number, and none past them',
  (plugin) => {
    const engine = startEngine({ initial: { edits: [createNode(plugin, node), DeviceEdit.SetOutput({ node })] } })
    const commands = plugin.params.map((param) =>
      Command.SetParam({ node, param: paramNumber(plugin, param.id), value: param.max })
    )
    engine.send(live(...commands, Command.SetParam({ node, param: plugin.params.length + 1, value: 0 })))
    engine.peak()
    expect(engine.readEvents()).toEqual([rejected('UnknownTarget')])
  }
)
