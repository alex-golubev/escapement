import { defaultStrip, defaultTempo, lastTick, plugins, Sha256, strip } from '@escapement/engine-description'
import { Option } from 'effect'
import { describe, expect, test } from 'vitest'
import * as Y from 'yjs'
import { createProject, defaultTrackStrip, Id, type PluginInstance, readProject, readProjectId } from '../src'
import {
  addDrum,
  by,
  drums,
  emptyProject,
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

/** A note of the first clip's, as any client could write it. */
const putNote = (doc: Y.Doc, id: string, note: unknown) => {
  const { clip } = parts(doc)
  rawNotes(doc, clip.pattern).set(id, note)
}

const shapePath = (track: Id) => ['tracks', track, 'instrument', 'params', 'osc1.shape']

test('the project tests start from reads as it was made, with nothing replaced', () => {
  const doc = newProject()
  const { value, replacements } = readProject(doc)
  expect(replacements).toEqual([])
  expect(value.tempo).toBe(defaultTempo)
  expect(value.tracks.map(({ name, mute, strip, instrument }) => ({ name, mute, strip, instrument }))).toEqual(
    drums.map(({ name, sound }) => ({
      name,
      mute: false,
      strip: defaultTrackStrip,
      instrument: Option.some({
        name: 'sampler',
        plugin: plugins.sampler,
        params: {},
        samples: { sample: sound }
      })
    }))
  )
  const [clip] = value.clips
  expect(value.clips).toEqual([
    { id: clip.id, track: value.tracks[0].id, tick: 0, pattern: clip.pattern, ownLength: Option.none(), offset: 0 }
  ])
  expect(value.patterns).toEqual([{ id: clip.pattern, notes: [] }])
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
  const { track } = parts(doc)
  rawMap(doc, 'tracks', track.id, 'instrument', 'params').set('volume', 0.8)
  const { value, replacements } = readProject(doc)
  expect(Option.getOrThrow(value.tracks[0].instrument).params).toEqual({})
  expect(replacements).toEqual([])
})

test('a document holds one project: creating another changes nothing', () => {
  const doc = newProject()
  expect(updatesDuring(doc, () => expect(createProject(doc, by)).toBe(false))).toBe(0)
})

test('each new project has an ID of its own; one made before projects had one, or with something else there, has none', () => {
  const doc = newProject()
  const made = readProjectId(doc)
  expect(Option.isSome(made)).toBe(true)
  expect(readProjectId(newProject())).not.toEqual(made)
  createProject(doc, by)
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
  createProject(doc, by, Id('given-id-123456a'))
  expect(readProjectId(doc)).toEqual(Option.some(Id('given-id-123456a')))
})

test('reading never writes to the document, even what it replaces', () => {
  const doc = newProjectWithSynth()
  rawMap(doc, 'tracks', synthOf(doc).id, 'instrument', 'params').set('osc1.shape', 'saw')
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
    rawMap(doc, 'tracks', synth.id, 'instrument', 'params').set('osc1.shape', found)
    const { replacements } = readProject(doc)
    expect(Option.getOrThrow(synthOf(doc).instrument).params).toEqual(synthDefaults)
    expect(replacements).toEqual([{ path: shapePath(synth.id), found, read: 'default' }])
  })

  test('in every other field', () => {
    const doc = newProject()
    const { track } = parts(doc)
    rawMap(doc, 'meta').set('bpm', 'fast')
    rawMap(doc, 'tracks', track.id).set('mute', 'yes')
    rawMap(doc, 'tracks', track.id).set('name', 42)
    rawMap(doc, 'tracks', track.id).set('pan', 'left')
    const { value, replacements } = readProject(doc)
    expect(value.tempo).toBe(defaultTempo)
    expect(value.tracks.find(({ id }) => id === track.id)).toMatchObject({
      name: '',
      mute: false,
      strip: defaultTrackStrip
    })
    expect(replacements.map(({ path, read }) => [path.join('/'), read])).toEqual([
      ['meta/bpm', 'default'],
      [`tracks/${track.id}/name`, 'default'],
      [`tracks/${track.id}/mute`, 'default'],
      [`tracks/${track.id}/pan`, 'default']
    ])
  })
})

test('a number past its range reads as the nearest one in it, a whole one as the nearest whole number', () => {
  const doc = newProjectWithSynth()
  const { track, clip, slot } = parts(doc)
  const synth = synthOf(doc)
  rawMap(doc, 'tracks', synth.id, 'instrument', 'params').set('osc1.shape', 1.4)
  rawMap(doc, 'tracks', track.id).set('volume', 3)
  rawMap(doc, 'tracks', track.id).set('pan', -3)
  rawMap(doc, 'master', 'slots', slot.id, 'params').set('cutoff', 25_000)
  rawMap(doc, 'meta').set('bpm', 1000)
  putNote(doc, 'n1', { tick: 240.4, len: 0, key: 9999, vel: -0.5 })
  putNote(doc, 'n2', { tick: 480, len: 240, key: 60.4, vel: 2 })
  const { value, replacements } = readProject(doc)
  expect(Option.getOrThrow(synthOf(doc).instrument).params).toEqual({ ...synthDefaults, 'osc1.shape': 1 })
  expect(value.tracks[0].strip).toEqual({ volume: volumeTop, pan: -1 })
  expect(value.master.slots[0].params).toEqual({ cutoff: 20_000 })
  expect(value.tempo).toBe(522)
  expect(value.patterns[0].notes).toEqual([
    { id: 'n1', tick: 240, length: 1, key: 127, velocity: 0 },
    { id: 'n2', tick: 480, length: 240, key: 60, velocity: 1 }
  ])
  const note = (id: string, field: string) => `notes/${clip.pattern}/${id}/${field}`
  expect(replacements.map(({ path, read }) => [path.join('/'), read])).toEqual([
    ['meta/bpm', 'nearest'],
    [`tracks/${track.id}/volume`, 'nearest'],
    [`tracks/${track.id}/pan`, 'nearest'],
    [shapePath(synth.id).join('/'), 'nearest'],
    [note('n1', 'tick'), 'nearest'],
    [note('n1', 'len'), 'nearest'],
    [note('n1', 'key'), 'nearest'],
    [note('n1', 'vel'), 'nearest'],
    [note('n2', 'key'), 'nearest'],
    [note('n2', 'vel'), 'nearest'],
    [`master/slots/${slot.id}/params/cutoff`, 'nearest']
  ])
})

test('a note without a tick in range is left out: no default puts it anywhere', () => {
  const doc = newProject()
  const { clip } = parts(doc)
  const broken = {
    b1: { key: 60 },
    b2: { tick: -240 },
    b3: { tick: 2 ** 32 },
    b4: { tick: '0' },
    b5: 'a note'
  }
  Object.entries(broken).forEach(([id, note]) => putNote(doc, id, note))
  putNote(doc, 'ok', { tick: 0 })
  const { value, replacements } = readProject(doc)
  expect(value.patterns[0].notes.map(({ id }) => id)).toEqual(['ok'])
  expect(replacements).toEqual(
    Object.entries(broken).map(([id, found]) => ({
      path: [`notes/${clip.pattern}`, id],
      found,
      read: 'skipped'
    }))
  )
})

test('a clip without a track, a tick in range or a pattern is left out; a tick or a length between, the nearest', () => {
  const doc = emptyProject()
  const track = addDrum(doc, drums[0])
  const clip = (fields: Record<string, unknown>) =>
    new Y.Map<unknown>(Object.entries({ track, bounds: { tick: 0 }, pattern: 'p', deleted: false, ...fields }))
  const broken = {
    c1: { track: 1 },
    c2: { track: undefined },
    c3: { bounds: { tick: -1 } },
    c4: { bounds: { tick: 2 ** 32 } },
    c5: { bounds: 0 },
    c6: { pattern: 7 },
    c7: { pattern: '' }
  }
  const clips = doc.getMap('clips')
  Object.entries(broken).forEach(([id, fields]) => clips.set(id, clip(fields)))
  clips.set('between', clip({ bounds: { tick: 959.6 } }))
  // A length of its own read whole and ending by the latest end; one not a number as none, the pattern's.
  clips.set('long', clip({ bounds: { tick: 0, length: 3840 } }))
  clips.set('odd', clip({ bounds: { tick: 0, length: 0.4 } }))
  clips.set('late', clip({ bounds: { tick: lastTick, length: 10 } }))
  clips.set('word', clip({ bounds: { tick: 0, length: 'long' } }))
  // An offset read whole, no further either way than the last tick; one not a number as 0.
  clips.set('within', clip({ bounds: { tick: 0, offset: 480 } }))
  clips.set('wide', clip({ bounds: { tick: 0, offset: -3.5 } }))
  clips.set('wordy', clip({ bounds: { tick: 0, offset: 'half' } }))
  clips.set('junk', 'a clip')
  // One on a track not live is left out quietly, broken or not: no one sees it.
  clips.set('nobody', clip({ track: 'nobody', bounds: { tick: 0.5 } }))
  clips.set('empty', clip({ track: '' }))
  const { value, replacements } = readProject(doc)
  const read = (id: string, tick: number, ownLength: Option.Option<number>, offset = 0) => ({
    id,
    track,
    tick,
    pattern: 'p',
    ownLength,
    offset
  })
  expect(value.clips).toEqual([
    read('between', 960, Option.none()),
    read('late', lastTick, Option.some(1)),
    read('long', 0, Option.some(3840)),
    read('odd', 0, Option.some(1)),
    read('wide', 0, Option.none(), -3),
    read('within', 0, Option.none(), 480),
    read('word', 0, Option.none()),
    read('wordy', 0, Option.none())
  ])
  expect(value.patterns).toEqual([{ id: 'p', notes: [] }])
  expect(replacements).toEqual([
    ...Object.entries(broken).map(([id, fields]) => ({
      path: ['clips', id],
      found: { track, bounds: { tick: 0 }, pattern: 'p', ...fields },
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

test("the clips' patterns are read once each, by ID, however many clips name one", () => {
  const doc = emptyProject()
  const track = addDrum(doc, drums[0])
  const clips = doc.getMap('clips')
  ;[
    ['a', 'z'],
    ['b', 'y'],
    ['c', 'z']
  ].forEach(([id, pattern]) =>
    clips.set(id, new Y.Map<unknown>(Object.entries({ track, bounds: { tick: 0 }, pattern, deleted: false })))
  )
  rawNotes(doc, Id('z')).set('n', { tick: 0 })
  expect(projectOf(doc).patterns.map(({ id, notes }) => ({ id, notes: notes.length }))).toEqual([
    { id: 'y', notes: 0 },
    { id: 'z', notes: 1 }
  ])
})

test('a note ends by the tick after the last: a longer one reads as the longest that does', () => {
  const doc = newProject()
  putNote(doc, 'n', { tick: lastTick - 9, len: 240 })
  const { value, replacements } = readProject(doc)
  expect(value.patterns[0].notes.map(({ tick, length }) => ({ tick, length }))).toEqual([
    { tick: lastTick - 9, length: 10 }
  ])
  expect(replacements.map(({ path, read }) => [path.at(-1), read])).toEqual([['len', 'nearest']])
})

test("a note's fields left out are a new note's", () => {
  const doc = newProject()
  putNote(doc, 'n', { tick: 960 })
  const { value, replacements } = readProject(doc)
  expect(value.patterns[0].notes).toEqual([{ id: 'n', tick: 960, length: 240, key: 60, velocity: 1 }])
  expect(replacements).toEqual([])
})

test('notes read by ID, the same on every client', () => {
  const doc = newProject()
  ;['c', 'a', 'b'].forEach((id, i) => putNote(doc, id, { tick: i * 240 }))
  expect(projectOf(doc).patterns[0].notes.map(({ id }) => id)).toEqual(['a', 'b', 'c'])
})

test('tracks read in their order; two with the same, by ID', () => {
  const doc = newProject()
  const ids = projectOf(doc).tracks.map(({ id }) => id)
  const orders = ['a3', 'a1', 'a2', 'a0']
  ids.forEach((id, i) => rawMap(doc, 'tracks', id).set('order', orders[i]))
  // Made in the other order: any ID the project made sorts after `-` and before `~`.
  ;['~', '-'].forEach((id) => rawMap(doc, 'tracks').set(id, new Y.Map([['order', 'a1']])))
  expect(projectOf(doc).tracks.map(({ id }) => id)).toEqual([ids[3], '-', ids[1], '~', ids[2], ids[0]])
})

test('a deleted track is left out quietly, its clips and their patterns with it; an entry that is no map, with a replacement', () => {
  const doc = newProject()
  const { track } = parts(doc)
  rawMap(doc, 'tracks', track.id).set('deleted', true)
  rawMap(doc, 'tracks').set('junk', 'a track')
  const { value, replacements } = readProject(doc)
  expect(value.tracks.map(({ id }) => id)).not.toContain(track.id)
  expect(value.tracks).toHaveLength(drums.length - 1)
  expect(value.clips).toEqual([])
  expect(value.patterns).toEqual([])
  expect(replacements).toEqual([{ path: ['tracks', 'junk'], found: 'a track', read: 'skipped' }])
})

describe('an instrument this build cannot play leaves its track silent', () => {
  test.each([
    ['a plugin it lacks', { id: 99, version: 1 }],
    ['a later version', { id: plugins.sampler.id, version: plugins.sampler.version + 1 }],
    ['no plugin at all', 'sampler']
  ])('%s', (_, ref) => {
    const doc = newProject()
    const { track } = parts(doc)
    rawMap(doc, 'tracks', track.id, 'instrument').set('plugin', ref)
    const { value, replacements } = readProject(doc)
    expect(value.tracks[0]).toMatchObject({ id: track.id, name: 'Kick', instrument: Option.none() })
    expect(replacements).toEqual([{ path: ['tracks', track.id, 'instrument', 'plugin'], found: ref, read: 'skipped' }])
  })

  test('no instrument', () => {
    const doc = newProject()
    const { track } = parts(doc)
    rawMap(doc, 'tracks', track.id).delete('instrument')
    const { value, replacements } = readProject(doc)
    expect(value.tracks[0].instrument).toEqual(Option.none())
    expect(replacements).toEqual([{ path: ['tracks', track.id, 'instrument'], found: undefined, read: 'skipped' }])
  })
})

test.each([
  ['a SHA-256 in capitals', Sha256('ab'.repeat(32)).toUpperCase()],
  ['null', null]
])('a sound that is no SHA-256, such as %s, is no sound and is reported', (_, found) => {
  const doc = newProject()
  const { track } = parts(doc)
  rawMap(doc, 'tracks', track.id, 'instrument', 'samples').set('sample', found)
  const { value, replacements } = readProject(doc)
  expect(Option.getOrThrow(value.tracks[0].instrument).samples).toEqual({})
  expect(replacements.map(({ path, read }) => [path, read])).toEqual([
    [['tracks', track.id, 'instrument', 'samples', 'sample'], 'default']
  ])
})

test('what a document leaves out reads as its default, quietly: it may be older than the field', () => {
  const doc = newProjectWithSynth()
  const { track } = parts(doc)
  const synth = synthOf(doc)
  const map = rawMap(doc, 'tracks', track.id)
  ;['name', 'mute', 'order', 'deleted', 'volume', 'pan'].forEach((key) => map.delete(key))
  rawMap(doc, 'tracks', synth.id, 'instrument').delete('params')
  rawMap(doc, 'meta').delete('bpm')
  const { value, replacements } = readProject(doc)
  expect(value.tempo).toBe(defaultTempo)
  expect(value.tracks[0]).toMatchObject({ id: track.id, name: '', mute: false, strip: defaultTrackStrip })
  expect(Option.getOrThrow(synthOf(doc).instrument).params).toEqual(synthDefaults)
  expect(replacements).toEqual([])
})

describe('the master', () => {
  test('its slots missing, has none', () => {
    const doc = newProject()
    rawMap(doc, 'master').delete('slots')
    expect(readProject(doc)).toMatchObject({ value: { master: { slots: [] } }, replacements: [] })
  })

  test('its slots broken, has none, with a replacement', () => {
    const doc = newProject()
    rawMap(doc, 'master').set('slots', 'a list')
    expect(readProject(doc)).toMatchObject({
      value: { master: { slots: [] } },
      replacements: [{ path: ['master', 'slots'], found: 'a list', read: 'default' }]
    })
  })

  test('leaves out a slot whose plugin this build lacks', () => {
    const doc = newProject()
    const { slot } = parts(doc)
    rawMap(doc, 'master', 'slots', slot.id).set('plugin', { id: 99, version: 1 })
    expect(projectOf(doc).master.slots).toEqual([])
    expect(replacementsOf(doc)).toEqual([
      { path: ['master', 'slots', slot.id, 'plugin'], found: { id: 99, version: 1 }, read: 'skipped' }
    ])
  })

  test("has the engine's strip, at the sound as it is, its values read into range", () => {
    const doc = newProject()
    expect(projectOf(doc).master.strip).toEqual(defaultStrip)
    rawMap(doc, 'master').set('volume', 9)
    rawMap(doc, 'master').set('pan', 'left')
    expect(projectOf(doc).master.strip).toEqual({ volume: volumeTop, pan: 0 })
    expect(replacementsOf(doc)).toEqual([
      { path: ['master', 'volume'], found: 9, read: 'nearest' },
      { path: ['master', 'pan'], found: 'left', read: 'default' }
    ])
  })
})
