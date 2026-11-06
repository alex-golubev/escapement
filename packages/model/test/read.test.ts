import { defaultStrip, defaultTempo, lastTick, plugins, Sha256, strip } from '@escapement/engine-description'
import { Option } from 'effect'
import { describe, expect, test } from 'vitest'
import * as Y from 'yjs'
import { createProject, defaultChannelStrip, Id, type PluginInstance, readProject, readProjectId } from '../src'
import {
  by,
  drums,
  newProject,
  newProjectWithSynth,
  parts,
  projectOf,
  rawMap,
  rawNotes,
  replacementsOf,
  synthOf,
  updatesDuring,
  synthDefaults
} from './project'

/** How loud the engine's strip goes: a fader's top. */
const volumeTop = Option.getOrThrow(Option.fromUndefinedOr(strip.find(({ id }) => id === 'volume'))).max

const [shape] = plugins.synth.params
const [cutoff] = plugins.filter.params

/** A note as any client could write it. */
const putNote = (doc: Y.Doc, id: string, note: unknown) => {
  const { pattern } = parts(doc)
  rawNotes(doc, pattern.id).set(id, note)
}

const shapePath = (channel: Id) => ['channels', channel, 'instrument', 'params', 'osc1.shape']

test('a new project reads as it was created, with nothing replaced', () => {
  const { value, replacements } = readProject(newProject())
  expect(replacements).toEqual([])
  expect(value.tempo).toBe(defaultTempo)
  expect(value.channels.map(({ name, mute, strip, instrument }) => ({ name, mute, strip, instrument }))).toEqual(
    drums.map(({ name, sound }) => ({
      name,
      mute: false,
      strip: defaultChannelStrip,
      instrument: Option.some({
        name: 'sampler',
        plugin: plugins.sampler,
        params: {},
        samples: { sample: sound }
      })
    }))
  )
  expect(value.patterns.map(({ name, notes }) => ({ name, notes }))).toEqual([{ name: 'Pattern 1', notes: [] }])
  expect(value.master.slots.map(({ name, plugin, params }) => ({ name, plugin, params }))).toEqual([
    { name: 'filter', plugin: plugins.filter, params: { cutoff: cutoff.default } }
  ])
})

test("an instrument's name tells which parameters it has", () => {
  const shapeOf = (instrument: PluginInstance) =>
    Option.liftPredicate(instrument, (instrument) => instrument.name === 'synth').pipe(
      Option.map((synth) => {
        // @ts-expect-error A synth has no cutoff.
        synth.params.cutoff
        const value: number = synth.params['osc1.shape']
        return value
      }),
      Option.getOrUndefined
    )
  expect(shapeOf(Option.getOrThrow(synthOf(newProjectWithSynth()).instrument))).toBe(shape.default)
})

test("a parameter the instrument doesn't have is left out, quietly: a sampler's volume, from before it had none", () => {
  const doc = newProject()
  const { channel } = parts(doc)
  rawMap(doc, 'channels', channel.id, 'instrument', 'params').set('volume', 0.8)
  const { value, replacements } = readProject(doc)
  expect(Option.getOrThrow(value.channels[0].instrument).params).toEqual({})
  expect(replacements).toEqual([])
})

test('a document holds one project: creating another changes nothing', () => {
  const doc = newProject()
  expect(updatesDuring(doc, () => expect(createProject(doc, by, drums)).toBe(false))).toBe(0)
})

test('each new project has an ID of its own; one made before projects had one, or with something else there, has none', () => {
  const doc = newProject()
  const made = readProjectId(doc)
  expect(Option.isSome(made)).toBe(true)
  expect(readProjectId(newProject())).not.toEqual(made)
  createProject(doc, by, drums)
  expect(readProjectId(doc)).toEqual(made)
  const loaded = new Y.Doc()
  Y.applyUpdate(loaded, Y.encodeStateAsUpdate(doc))
  expect(readProjectId(loaded)).toEqual(made)
  rawMap(doc, 'meta').set('id', 7)
  expect(readProjectId(doc)).toEqual(Option.none())
  rawMap(doc, 'meta').set('id', '')
  expect(readProjectId(doc)).toEqual(Option.none())
  rawMap(doc, 'meta').delete('id')
  expect(readProjectId(doc)).toEqual(Option.none())
  expect(readProjectId(new Y.Doc())).toEqual(Option.none())
})

test('a project is made with the ID given, as its address names it', () => {
  const doc = new Y.Doc()
  createProject(doc, by, drums, Id('given-id-123456a'))
  expect(readProjectId(doc)).toEqual(Option.some(Id('given-id-123456a')))
})

test('reading never writes to the document, even what it replaces', () => {
  const doc = newProjectWithSynth()
  rawMap(doc, 'channels', synthOf(doc).id, 'instrument', 'params').set('osc1.shape', 'saw')
  rawMap(doc, 'meta').set('bpm', 1000)
  const before = Y.encodeStateAsUpdate(doc)
  expect(updatesDuring(doc, () => readProject(doc))).toBe(0)
  expect(Y.encodeStateAsUpdate(doc)).toEqual(before)
  const empty = new Y.Doc()
  expect(updatesDuring(empty, () => readProject(empty))).toBe(0)
})

describe('a value of the wrong type reads as its default', () => {
  test.each([
    ['a string', 'loud'],
    ['nothing', null],
    ['not a number', Number.NaN],
    ['infinity', Number.POSITIVE_INFINITY],
    ['a map', new Y.Map()]
  ])("%s in a synth's shape", (_, found) => {
    const doc = newProjectWithSynth()
    const synth = synthOf(doc)
    rawMap(doc, 'channels', synth.id, 'instrument', 'params').set('osc1.shape', found)
    const { replacements } = readProject(doc)
    expect(Option.getOrThrow(synthOf(doc).instrument).params).toEqual(synthDefaults)
    expect(replacements).toEqual([{ path: shapePath(synth.id), found, read: 'default' }])
  })

  test('in every other field', () => {
    const doc = newProject()
    const { channel, pattern } = parts(doc)
    rawMap(doc, 'meta').set('bpm', 'fast')
    rawMap(doc, 'channels', channel.id).set('mute', 'yes')
    rawMap(doc, 'channels', channel.id).set('name', 42)
    rawMap(doc, 'channels', channel.id).set('pan', 'left')
    rawMap(doc, 'patterns', pattern.id).set('name', [])
    const { value, replacements } = readProject(doc)
    expect(value.tempo).toBe(defaultTempo)
    expect(value.channels.find(({ id }) => id === channel.id)).toMatchObject({
      name: '',
      mute: false,
      strip: defaultChannelStrip
    })
    expect(value.patterns[0].name).toBe('')
    expect(replacements.map(({ path, read }) => [path.join('/'), read])).toEqual([
      ['meta/bpm', 'default'],
      [`channels/${channel.id}/name`, 'default'],
      [`channels/${channel.id}/mute`, 'default'],
      [`channels/${channel.id}/pan`, 'default'],
      [`patterns/${pattern.id}/name`, 'default']
    ])
  })
})

test('a number past its range reads as the nearest one in it, a whole one as the nearest whole number', () => {
  const doc = newProjectWithSynth()
  const { channel, pattern, slot } = parts(doc)
  const synth = synthOf(doc)
  rawMap(doc, 'channels', synth.id, 'instrument', 'params').set('osc1.shape', 1.4)
  rawMap(doc, 'channels', channel.id).set('volume', 2)
  rawMap(doc, 'channels', channel.id).set('pan', -3)
  rawMap(doc, 'mixer/master', 'slots', slot.id, 'params').set('cutoff', 25_000)
  rawMap(doc, 'meta').set('bpm', 1000)
  putNote(doc, 'n1', { channel: channel.id, tick: 240.4, len: 0, key: 9999, vel: -0.5 })
  putNote(doc, 'n2', { channel: channel.id, tick: 480, len: 240, key: 60.4, vel: 2 })
  const { value, replacements } = readProject(doc)
  expect(Option.getOrThrow(synthOf(doc).instrument).params).toEqual({ ...synthDefaults, 'osc1.shape': 1 })
  expect(value.channels[0].strip).toEqual({ volume: 1, pan: -1 })
  expect(value.master.slots[0].params).toEqual({ cutoff: 20_000 })
  expect(value.tempo).toBe(522)
  expect(value.patterns[0].notes).toEqual([
    { id: 'n1', channel: channel.id, tick: 240, length: 1, key: 127, velocity: 0 },
    { id: 'n2', channel: channel.id, tick: 480, length: 240, key: 60, velocity: 1 }
  ])
  const note = (id: string, field: string) => `notes/${pattern.id}/${id}/${field}`
  expect(replacements.map(({ path, read }) => [path.join('/'), read])).toEqual([
    ['meta/bpm', 'nearest'],
    [`channels/${channel.id}/volume`, 'nearest'],
    [`channels/${channel.id}/pan`, 'nearest'],
    [shapePath(synth.id).join('/'), 'nearest'],
    [note('n1', 'tick'), 'nearest'],
    [note('n1', 'len'), 'nearest'],
    [note('n1', 'key'), 'nearest'],
    [note('n1', 'vel'), 'nearest'],
    [note('n2', 'key'), 'nearest'],
    [note('n2', 'vel'), 'nearest'],
    [`mixer/master/slots/${slot.id}/params/cutoff`, 'nearest']
  ])
})

test('a note without a channel or a tick is left out: no default puts it anywhere', () => {
  const doc = newProject()
  const { channel, pattern } = parts(doc)
  const broken = {
    b1: { tick: 0, key: 60 },
    b2: { channel: '', tick: 0 },
    b3: { channel: channel.id, tick: -240 },
    b4: { channel: channel.id, tick: 2 ** 32 },
    b5: { channel: channel.id, tick: '0' },
    b6: { channel: 7, tick: 0 },
    b7: 'a note'
  }
  Object.entries(broken).forEach(([id, note]) => putNote(doc, id, note))
  putNote(doc, 'ok', { channel: channel.id, tick: 0 })
  const { value, replacements } = readProject(doc)
  expect(value.patterns[0].notes.map(({ id }) => id)).toEqual(['ok'])
  expect(replacements).toEqual(
    Object.entries(broken).map(([id, found]) => ({
      path: [`notes/${pattern.id}`, id],
      found,
      read: 'skipped'
    }))
  )
})

test("a clip without one of the arrangement's tracks, a tick in range or a pattern is left out; a tick or a length between, the nearest", () => {
  const doc = newProject()
  const { pattern } = parts(doc)
  const clip = (fields: Record<string, unknown>) =>
    new Y.Map<unknown>(
      Object.entries({ track: '1', bounds: { tick: 0 }, pattern: pattern.id, deleted: false, ...fields })
    )
  const broken = {
    c1: { track: '0' },
    c2: { track: 1 },
    c3: { track: undefined },
    c4: { bounds: { tick: -1 } },
    c5: { bounds: { tick: 2 ** 32 } },
    c6: { bounds: 0 },
    c7: { pattern: 7 }
  }
  const clips = doc.getMap('clips')
  Object.entries(broken).forEach(([id, fields]) => clips.set(id, clip(fields)))
  clips.set('between', clip({ bounds: { tick: 959.6 } }))
  // A length of its own read whole and ending by the latest end; one not a number as none, the pattern's.
  clips.set('long', clip({ track: '2', bounds: { tick: 0, length: 3840 } }))
  clips.set('odd', clip({ track: '3', bounds: { tick: 0, length: 0.4 } }))
  clips.set('late', clip({ track: '4', bounds: { tick: lastTick, length: 10 } }))
  clips.set('word', clip({ track: '5', bounds: { tick: 0, length: 'long' } }))
  // An offset read whole, no further either way than the last tick; one not a number as 0.
  clips.set('within', clip({ track: '6', bounds: { tick: 0, offset: 480 } }))
  clips.set('wide', clip({ track: '7', bounds: { tick: 0, offset: -3.5 } }))
  clips.set('wordy', clip({ track: '8', bounds: { tick: 0, offset: 'half' } }))
  clips.set('junk', 'a clip')
  // One of a pattern not live is left out quietly, broken or not: no one sees it.
  clips.set('nobody', clip({ pattern: 'nobody', bounds: { tick: 0.5 } }))
  clips.set('empty', clip({ pattern: '' }))
  const { value, replacements } = readProject(doc)
  const read = (id: string, track: string, tick: number, ownLength: Option.Option<number>, offset = 0) => ({
    id,
    track,
    tick,
    pattern: pattern.id,
    ownLength,
    offset
  })
  expect(value.clips).toEqual([
    read('between', '1', 960, Option.none()),
    read('late', '4', lastTick, Option.some(1)),
    read('long', '2', 0, Option.some(3840)),
    read('odd', '3', 0, Option.some(1)),
    read('wide', '7', 0, Option.none(), -3),
    read('within', '6', 0, Option.none(), 480),
    read('word', '5', 0, Option.none()),
    read('wordy', '8', 0, Option.none())
  ])
  expect(replacements).toEqual([
    ...Object.entries(broken).map(([id, fields]) => ({
      path: ['clips', id],
      found: { track: '1', bounds: { tick: 0 }, pattern: pattern.id, ...fields },
      read: 'skipped'
    })),
    { path: ['clips', 'between', 'bounds'], found: { tick: 959.6 }, read: 'nearest' },
    { path: ['clips', 'odd', 'bounds', 'length'], found: 0.4, read: 'nearest' },
    { path: ['clips', 'late', 'bounds', 'length'], found: 10, read: 'nearest' },
    { path: ['clips', 'word', 'bounds', 'length'], found: 'long', read: 'default' },
    { path: ['clips', 'wide', 'bounds', 'offset'], found: -3.5, read: 'nearest' },
    { path: ['clips', 'wordy', 'bounds', 'offset'], found: 'half', read: 'default' },
    { path: ['clips', 'junk'], found: 'a clip', read: 'skipped' }
  ])
})

test('a note ends by the tick after the last: a longer one reads as the longest that does', () => {
  const doc = newProject()
  const { channel } = parts(doc)
  putNote(doc, 'n', { channel: channel.id, tick: lastTick - 9, len: 240 })
  const { value, replacements } = readProject(doc)
  expect(value.patterns[0].notes.map(({ tick, length }) => ({ tick, length }))).toEqual([
    { tick: lastTick - 9, length: 10 }
  ])
  expect(replacements.map(({ path, read }) => [path.at(-1), read])).toEqual([['len', 'nearest']])
})

test("a note's fields left out are a new note's", () => {
  const doc = newProject()
  const { channel } = parts(doc)
  putNote(doc, 'n', { channel: channel.id, tick: 960 })
  const { value, replacements } = readProject(doc)
  expect(value.patterns[0].notes).toEqual([
    { id: 'n', channel: channel.id, tick: 960, length: 240, key: 60, velocity: 1 }
  ])
  expect(replacements).toEqual([])
})

test('notes read by ID, the same on every client', () => {
  const doc = newProject()
  const { channel } = parts(doc)
  ;['c', 'a', 'b'].forEach((id, i) => putNote(doc, id, { channel: channel.id, tick: i * 240 }))
  expect(projectOf(doc).patterns[0].notes.map(({ id }) => id)).toEqual(['a', 'b', 'c'])
})

test('patterns read in their order; two with the same, by ID', () => {
  const doc = newProject()
  const { pattern } = parts(doc)
  rawMap(doc, 'patterns', pattern.id).set('order', 'a1')
  // Made in the other order: any ID the project made sorts after `-` and before `~`.
  ;['~', '-'].forEach((id) => rawMap(doc, 'patterns').set(id, new Y.Map([['order', 'a1']])))
  rawMap(doc, 'patterns').set('first', new Y.Map([['order', 'a0']]))
  expect(projectOf(doc).patterns.map(({ id }) => id)).toEqual(['first', '-', pattern.id, '~'])
})

test('channels read in their order; two with the same, by ID', () => {
  const doc = newProject()
  const ids = projectOf(doc).channels.map(({ id }) => id)
  const orders = ['a3', 'a1', 'a2', 'a0']
  ids.forEach((id, i) => rawMap(doc, 'channels', id).set('order', orders[i]))
  // Made in the other order: any ID the project made sorts after `-` and before `~`.
  ;['~', '-'].forEach((id) => rawMap(doc, 'channels').set(id, new Y.Map([['order', 'a1']])))
  expect(projectOf(doc).channels.map(({ id }) => id)).toEqual([ids[3], '-', ids[1], '~', ids[2], ids[0]])
})

test('a deleted channel or pattern is left out quietly; an entry that is no map, with a replacement', () => {
  const doc = newProject()
  const { channel, pattern } = parts(doc)
  rawMap(doc, 'channels', channel.id).set('deleted', true)
  rawMap(doc, 'patterns', pattern.id).set('deleted', true)
  rawMap(doc, 'channels').set('junk', 'a channel')
  const { value, replacements } = readProject(doc)
  expect(value.channels.map(({ id }) => id)).not.toContain(channel.id)
  expect(value.channels).toHaveLength(drums.length - 1)
  expect(value.patterns).toEqual([])
  expect(replacements).toEqual([{ path: ['channels', 'junk'], found: 'a channel', read: 'skipped' }])
})

describe('an instrument this build cannot play leaves its channel silent', () => {
  test.each([
    ['a plugin it lacks', { id: 99, version: 1 }],
    ['a later version', { id: plugins.sampler.id, version: plugins.sampler.version + 1 }],
    ['no plugin at all', 'sampler']
  ])('%s', (_, ref) => {
    const doc = newProject()
    const { channel } = parts(doc)
    rawMap(doc, 'channels', channel.id, 'instrument').set('plugin', ref)
    const { value, replacements } = readProject(doc)
    expect(value.channels[0]).toMatchObject({ id: channel.id, name: 'Kick', instrument: Option.none() })
    expect(replacements).toEqual([
      { path: ['channels', channel.id, 'instrument', 'plugin'], found: ref, read: 'skipped' }
    ])
  })

  test('no instrument', () => {
    const doc = newProject()
    const { channel } = parts(doc)
    rawMap(doc, 'channels', channel.id).delete('instrument')
    const { value, replacements } = readProject(doc)
    expect(value.channels[0].instrument).toEqual(Option.none())
    expect(replacements).toEqual([{ path: ['channels', channel.id, 'instrument'], found: undefined, read: 'skipped' }])
  })
})

test.each([
  ['a SHA-256 in capitals', Sha256('ab'.repeat(32)).toUpperCase()],
  ['null', null]
])('a sound that is no SHA-256, such as %s, is no sound and is reported', (_, found) => {
  const doc = newProject()
  const { channel } = parts(doc)
  rawMap(doc, 'channels', channel.id, 'instrument', 'samples').set('sample', found)
  const { value, replacements } = readProject(doc)
  expect(Option.getOrThrow(value.channels[0].instrument).samples).toEqual({})
  expect(replacements.map(({ path, read }) => [path, read])).toEqual([
    [['channels', channel.id, 'instrument', 'samples', 'sample'], 'default']
  ])
})

test('what a document leaves out reads as its default, quietly: it may be older than the field', () => {
  const doc = newProjectWithSynth()
  const { channel } = parts(doc)
  const synth = synthOf(doc)
  const map = rawMap(doc, 'channels', channel.id)
  ;['name', 'mute', 'order', 'deleted', 'volume', 'pan'].forEach((key) => map.delete(key))
  rawMap(doc, 'channels', synth.id, 'instrument').delete('params')
  rawMap(doc, 'meta').delete('bpm')
  const { value, replacements } = readProject(doc)
  expect(value.tempo).toBe(defaultTempo)
  expect(value.channels[0]).toMatchObject({ id: channel.id, name: '', mute: false, strip: defaultChannelStrip })
  expect(Option.getOrThrow(synthOf(doc).instrument).params).toEqual(synthDefaults)
  expect(replacements).toEqual([])
})

describe('the master insert', () => {
  test('its slots missing, has none', () => {
    const doc = newProject()
    rawMap(doc, 'mixer/master').delete('slots')
    expect(readProject(doc)).toMatchObject({ value: { master: { slots: [] } }, replacements: [] })
  })

  test('its slots broken, has none, with a replacement', () => {
    const doc = newProject()
    rawMap(doc, 'mixer/master').set('slots', 'a list')
    expect(readProject(doc)).toMatchObject({
      value: { master: { slots: [] } },
      replacements: [{ path: ['mixer/master', 'slots'], found: 'a list', read: 'default' }]
    })
  })

  test('leaves out a slot whose plugin this build lacks', () => {
    const doc = newProject()
    const { slot } = parts(doc)
    rawMap(doc, 'mixer/master', 'slots', slot.id).set('plugin', { id: 99, version: 1 })
    expect(projectOf(doc).master.slots).toEqual([])
    expect(replacementsOf(doc)).toEqual([
      { path: ['mixer/master', 'slots', slot.id, 'plugin'], found: { id: 99, version: 1 }, read: 'skipped' }
    ])
  })

  test("has the engine's strip, at the sound as it is, its values read into range", () => {
    const doc = newProject()
    expect(projectOf(doc).master.strip).toEqual(defaultStrip)
    rawMap(doc, 'mixer/master').set('volume', 9)
    rawMap(doc, 'mixer/master').set('pan', 'left')
    expect(projectOf(doc).master.strip).toEqual({ volume: volumeTop, pan: 0 })
    expect(replacementsOf(doc)).toEqual([
      { path: ['mixer/master', 'volume'], found: 9, read: 'nearest' },
      { path: ['mixer/master', 'pan'], found: 'left', read: 'default' }
    ])
  })
})

describe('the inserts besides the master', () => {
  test('are none in a new project, and each the document holds anything of is read, by its number', () => {
    const doc = newProject()
    expect(projectOf(doc).inserts).toEqual([])
    rawMap(doc, 'mixer/12').set('mute', true)
    rawMap(doc, 'mixer/3').set('volume', 0.5)
    expect(projectOf(doc).inserts).toEqual([
      { id: '3', strip: { ...defaultStrip, volume: 0.5 }, mute: false },
      { id: '12', strip: defaultStrip, mute: true }
    ])
  })

  test('only of the built-in ones, and one read without being written is none', () => {
    const doc = newProject()
    ;['0', '501', 'master2', 'x'].forEach((id) => rawMap(doc, `mixer/${id}`).set('mute', true))
    doc.getMap('mixer/7')
    expect(projectOf(doc).inserts).toEqual([])
  })

  test("read their values into range, a mute that isn't one as none", () => {
    const doc = newProject()
    rawMap(doc, 'mixer/1').set('volume', -2)
    rawMap(doc, 'mixer/1').set('mute', 'yes')
    expect(readProject(doc)).toMatchObject({
      value: { inserts: [{ id: '1', strip: { volume: 0, pan: 0 }, mute: false }] },
      replacements: [
        { path: ['mixer/1', 'volume'], found: -2, read: 'nearest' },
        { path: ['mixer/1', 'mute'], found: 'yes', read: 'default' }
      ]
    })
  })
})

describe('the insert a channel goes into', () => {
  const insertOf = (doc: Y.Doc) => projectOf(doc).channels[0].insert

  test('is the master unless it names another', () => {
    const doc = newProject()
    const { channel } = parts(doc)
    expect(insertOf(doc)).toBe('master')
    rawMap(doc, 'channels', channel.id).set('insert', '500')
    expect(insertOf(doc)).toBe('500')
    rawMap(doc, 'channels', channel.id).set('insert', 'master')
    expect(insertOf(doc)).toBe('master')
    expect(replacementsOf(doc)).toEqual([])
  })

  test('is the master, with a replacement, for anything but an insert there is', () => {
    const doc = newProject()
    const { channel } = parts(doc)
    ;['0', '501', '', 3, null].forEach((found) => {
      rawMap(doc, 'channels', channel.id).set('insert', found)
      expect(insertOf(doc)).toBe('master')
      expect(replacementsOf(doc)).toEqual([{ path: ['channels', channel.id, 'insert'], found, read: 'default' }])
    })
  })
})
