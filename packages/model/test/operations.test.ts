import {
  defaultStrip,
  defaultTempo,
  formatValue,
  lastTick,
  newChannelPosition,
  MidiKey,
  maxTempo,
  minTempo,
  paramPosition,
  plugins,
  strip,
  Tick
} from '@escapement/engine-description'
import { Option } from 'effect'
import { describe, expect, test } from 'vitest'
import * as Y from 'yjs'
import {
  addChannel,
  addClip,
  addNote,
  addPattern,
  barTicks,
  clonePattern,
  channelStrip,
  createProject,
  defaultChannelStrip,
  deleteChannel,
  deletePattern,
  eraseClips,
  eraseNotes,
  Id,
  moveClip,
  moveNote,
  resizeClip,
  trimClip,
  renameChannel,
  renamePattern,
  setChannelInsert,
  setChannelParam,
  setChannelStrip,
  setInsertMute,
  setInsertStrip,
  setMasterParam,
  setMute,
  setTempo,
  stepNote,
  stepTicks,
  stretchNote,
  toggleStep
} from '../src'
import {
  brokenWays,
  by,
  cutoffOf,
  drums,
  newProject,
  newProjectWithSynth,
  parts,
  projectOf,
  rawMap,
  rawNotes,
  replacementsOf,
  sync,
  synthOf,
  updatesDuring,
  shapeOf,
  synthDefaults
} from './project'

const [cutoff] = plugins.filter.params

const notesOf = (doc: Y.Doc) => projectOf(doc).patterns[0].notes

const notesOn = (doc: Y.Doc, channel: Id, step: number) =>
  notesOf(doc).filter((note) => note.channel === channel && note.tick === step * stepTicks)

/** The last step whose note ends by the tick after the last. */
const lastStep = Math.floor((lastTick + 1 - stepNote.length) / stepTicks)

describe('a step', () => {
  test('switched on is a new note of the channel on its tick; switched again, it is off', () => {
    const doc = newProject()
    const { channel, pattern } = parts(doc)
    expect(toggleStep(doc, by, pattern.id, channel.id, 3)).toBe(true)
    expect(notesOf(doc)).toEqual([{ id: expect.any(String), channel: channel.id, tick: 720, ...stepNote }])
    expect(toggleStep(doc, by, pattern.id, channel.id, 3)).toBe(true)
    expect(notesOf(doc)).toEqual([])
  })

  test('switched off removes every note of the channel on its tick, whatever its key, and no other', () => {
    const doc = newProject()
    const { channels } = projectOf(doc)
    const { pattern } = parts(doc)
    const [kick, snare] = channels.map(({ id }) => id)
    const notes = rawNotes(doc, pattern.id)
    notes.set('high', { channel: kick, tick: 480, len: 240, key: 72, vel: 1 })
    notes.set('loud', { channel: kick, tick: 480, len: 240, key: 60, vel: 'loud' })
    notes.set('snare', { channel: snare, tick: 480, len: 240, key: 60, vel: 1 })
    notes.set('later', { channel: kick, tick: 720, len: 240, key: 60, vel: 1 })
    expect(toggleStep(doc, by, pattern.id, kick, 2)).toBe(true)
    expect(notesOf(doc).map(({ id }) => id)).toEqual(['later', 'snare'])
  })

  test('switched on last is the one whose note ends by the tick after the last', () => {
    const doc = newProject()
    const { channel, pattern } = parts(doc)
    expect(toggleStep(doc, by, pattern.id, channel.id, lastStep)).toBe(true)
    expect(notesOf(doc).map(({ tick, length }) => tick + length)).toEqual([lastStep * stepTicks + stepNote.length])
    expect(replacementsOf(doc)).toEqual([])
  })

  test.each([
    ['before the first', -1],
    ['between two', 1.5],
    ['whose note would end past the last tick', lastStep + 1],
    ['past the last tick', Math.floor(lastTick / stepTicks) + 1],
    ['not a number', Number.NaN]
  ])('%s is refused', (_, step) => {
    const doc = newProject()
    const { channel, pattern } = parts(doc)
    expect(updatesDuring(doc, () => expect(toggleStep(doc, by, pattern.id, channel.id, step)).toBe(false))).toBe(0)
  })

  test('of a channel or a pattern that is not there, or deleted, is refused', () => {
    const doc = newProject()
    const { channel, pattern } = parts(doc)
    const refused = () => {
      expect(toggleStep(doc, by, Id('nowhere'), channel.id, 0)).toBe(false)
      expect(toggleStep(doc, by, pattern.id, Id('nobody'), 0)).toBe(false)
    }
    expect(updatesDuring(doc, refused)).toBe(0)
    rawMap(doc, 'channels', channel.id).set('deleted', true)
    expect(updatesDuring(doc, () => expect(toggleStep(doc, by, pattern.id, channel.id, 0)).toBe(false))).toBe(0)
    const other = projectOf(doc).channels[0].id
    rawMap(doc, 'patterns', pattern.id).set('deleted', true)
    expect(updatesDuring(doc, () => expect(toggleStep(doc, by, pattern.id, other, 0)).toBe(false))).toBe(0)
  })

  test('switched on by two clients apart makes two notes; switched off by one, it is off for both', () => {
    const first = newProject()
    const second = new Y.Doc()
    sync(first, second)
    const { channel, pattern } = parts(first)
    expect(toggleStep(first, by, pattern.id, channel.id, 4)).toBe(true)
    expect(toggleStep(second, by, pattern.id, channel.id, 4)).toBe(true)
    sync(first, second)
    expect(notesOn(first, channel.id, 4)).toHaveLength(2)
    expect(notesOf(second)).toEqual(notesOf(first))
    expect(toggleStep(second, by, pattern.id, channel.id, 4)).toBe(true)
    sync(first, second)
    expect(notesOf(first)).toEqual([])
    expect(notesOf(second)).toEqual([])
  })
})

describe('a note', () => {
  const g5 = { tick: Tick(480), key: MidiKey(67), length: 720 }

  test('put is a new note of the channel where it starts, as high and long as asked, at full strength', () => {
    const doc = newProject()
    const { channel, pattern } = parts(doc)
    expect(addNote(doc, by, pattern.id, channel.id, g5)).toBe(true)
    expect(notesOf(doc)).toEqual([{ id: expect.any(String), channel: channel.id, ...g5, velocity: stepNote.velocity }])
    expect(replacementsOf(doc)).toEqual([])
  })

  test('put last is the one that ends by the tick after the last', () => {
    const doc = newProject()
    const { channel, pattern } = parts(doc)
    expect(addNote(doc, by, pattern.id, channel.id, { ...g5, tick: Tick(lastTick), length: 1 })).toBe(true)
    expect(replacementsOf(doc)).toEqual([])
  })

  test.each([
    ['of no length', { length: 0 }],
    ['of a length between two ticks', { length: 1.5 }],
    ['of a length that is not a number', { length: Number.NaN }],
    ['ending past the last tick', { tick: Tick(lastTick), length: 2 }]
  ])('%s is refused', (_, changed) => {
    const doc = newProject()
    const { channel, pattern } = parts(doc)
    const note = { ...g5, ...changed }
    expect(updatesDuring(doc, () => expect(addNote(doc, by, pattern.id, channel.id, note)).toBe(false))).toBe(0)
  })

  test('put into a channel or a pattern that is not there, or deleted, is refused', () => {
    const doc = newProject()
    const { channel, pattern } = parts(doc)
    const refused = () => {
      expect(addNote(doc, by, Id('nowhere'), channel.id, g5)).toBe(false)
      expect(addNote(doc, by, pattern.id, Id('nobody'), g5)).toBe(false)
    }
    expect(updatesDuring(doc, refused)).toBe(0)
    rawMap(doc, 'channels', channel.id).set('deleted', true)
    expect(updatesDuring(doc, () => expect(addNote(doc, by, pattern.id, channel.id, g5)).toBe(false))).toBe(0)
    const other = projectOf(doc).channels[0].id
    rawMap(doc, 'patterns', pattern.id).set('deleted', true)
    expect(updatesDuring(doc, () => expect(addNote(doc, by, pattern.id, other, g5)).toBe(false))).toBe(0)
  })

  test('put where a note of the channel starts as high takes its place; one of another channel stays', () => {
    const doc = newProject()
    const { channels } = projectOf(doc)
    const { pattern } = parts(doc)
    const [kick, snare] = channels.map(({ id }) => id)
    const notes = rawNotes(doc, pattern.id)
    notes.set('there', { channel: kick, tick: 480, len: 240, key: 67, vel: 0.5 })
    notes.set('higher', { channel: kick, tick: 480, len: 240, key: 68, vel: 1 })
    notes.set('snare', { channel: snare, tick: 480, len: 240, key: 67, vel: 1 })
    expect(addNote(doc, by, pattern.id, kick, g5)).toBe(true)
    expect(notesOf(doc).map(({ id, channel, key, length }) => ({ id, channel, key, length }))).toEqual(
      expect.arrayContaining([
        { id: expect.any(String), channel: kick, key: g5.key, length: g5.length },
        { id: 'higher', channel: kick, key: 68, length: 240 },
        { id: 'snare', channel: snare, key: 67, length: 240 }
      ])
    )
    expect(notesOf(doc)).toHaveLength(3)
  })

  test('moved starts and is as high as asked, the same note, as long and as strong', () => {
    const doc = newProject()
    const { channel, pattern } = parts(doc)
    addNote(doc, by, pattern.id, channel.id, g5)
    const [{ id }] = notesOf(doc)
    const to = { tick: Tick(960), key: MidiKey(60) }
    expect(moveNote(doc, by, pattern.id, id, to)).toBe(true)
    expect(notesOf(doc)).toEqual([{ id, channel: channel.id, ...to, length: g5.length, velocity: stepNote.velocity }])
    expect(replacementsOf(doc)).toEqual([])
  })

  test('stretched is as long as asked, where it was, the same note, as strong', () => {
    const doc = newProject()
    const { channel, pattern } = parts(doc)
    addNote(doc, by, pattern.id, channel.id, g5)
    const [{ id }] = notesOf(doc)
    expect(stretchNote(doc, by, pattern.id, id, 240)).toBe(true)
    expect(notesOf(doc)).toEqual([{ id, channel: channel.id, ...g5, length: 240, velocity: stepNote.velocity }])
  })

  test('moved takes the notes in its place with it, each as long, and takes the place of the notes where it lands', () => {
    const doc = newProject()
    const { channels } = projectOf(doc)
    const { pattern } = parts(doc)
    const [kick, snare] = channels.map(({ id }) => id)
    const notes = rawNotes(doc, pattern.id)
    notes.set('moved', { channel: kick, tick: 480, len: 240, key: 67, vel: 1 })
    notes.set('copy', { channel: kick, tick: 480, len: 960, key: 67, vel: 0.5 })
    notes.set('higher', { channel: kick, tick: 480, len: 240, key: 68, vel: 1 })
    notes.set('there', { channel: kick, tick: 0, len: 240, key: 60, vel: 1 })
    notes.set('snare', { channel: snare, tick: 0, len: 240, key: 60, vel: 1 })
    const to = { tick: Tick(0), key: MidiKey(60) }
    expect(moveNote(doc, by, pattern.id, Id('moved'), to)).toBe(true)
    expect(notesOf(doc).map(({ id, tick, key, length, velocity }) => ({ id, tick, key, length, velocity }))).toEqual([
      { id: 'copy', ...to, length: 960, velocity: 0.5 },
      { id: 'higher', tick: 480, key: 68, length: 240, velocity: 1 },
      { id: 'moved', ...to, length: 240, velocity: 1 },
      { id: 'snare', tick: 0, key: 60, length: 240, velocity: 1 }
    ])
  })

  test('stretched takes the notes in its place to its length, and no other', () => {
    const doc = newProject()
    const { channels } = projectOf(doc)
    const { pattern } = parts(doc)
    const [kick] = channels.map(({ id }) => id)
    const notes = rawNotes(doc, pattern.id)
    notes.set('stretched', { channel: kick, tick: 480, len: 240, key: 67, vel: 1 })
    notes.set('copy', { channel: kick, tick: 480, len: 960, key: 67, vel: 0.5 })
    notes.set('higher', { channel: kick, tick: 480, len: 240, key: 68, vel: 1 })
    expect(stretchNote(doc, by, pattern.id, Id('stretched'), 480)).toBe(true)
    expect(notesOf(doc).map(({ id, length }) => ({ id, length }))).toEqual([
      { id: 'copy', length: 480 },
      { id: 'higher', length: 240 },
      { id: 'stretched', length: 480 }
    ])
  })

  test('moved where it is, or stretched to its length, changes nothing', () => {
    const doc = newProject()
    const { channel, pattern } = parts(doc)
    addNote(doc, by, pattern.id, channel.id, g5)
    const [{ id }] = notesOf(doc)
    const unchanged = () => {
      expect(moveNote(doc, by, pattern.id, id, g5)).toBe(true)
      expect(stretchNote(doc, by, pattern.id, id, g5.length)).toBe(true)
    }
    expect(updatesDuring(doc, unchanged)).toBe(0)
  })

  test.each([
    [
      'moved to end past the last tick',
      (doc: Y.Doc, pattern: Id, id: Id) => moveNote(doc, by, pattern, id, { tick: Tick(lastTick), key: g5.key })
    ],
    ['stretched to no length', (doc: Y.Doc, pattern: Id, id: Id) => stretchNote(doc, by, pattern, id, 0)],
    [
      'stretched to a length between two ticks',
      (doc: Y.Doc, pattern: Id, id: Id) => stretchNote(doc, by, pattern, id, 1.5)
    ],
    [
      'stretched past the last tick',
      (doc: Y.Doc, pattern: Id, id: Id) => stretchNote(doc, by, pattern, id, lastTick + 2 - g5.tick)
    ]
  ])('%s is refused', (_, edit) => {
    const doc = newProject()
    const { channel, pattern } = parts(doc)
    addNote(doc, by, pattern.id, channel.id, g5)
    const [{ id }] = notesOf(doc)
    expect(updatesDuring(doc, () => expect(edit(doc, pattern.id, id)).toBe(false))).toBe(0)
  })

  test('moved or stretched once it is gone, of a channel deleted, or in a pattern not there or deleted, is refused', () => {
    const doc = newProject()
    const { channel, pattern } = parts(doc)
    addNote(doc, by, pattern.id, channel.id, g5)
    const [{ id }] = notesOf(doc)
    const refused = (pattern: Id, note: Id) =>
      expect(
        updatesDuring(doc, () => {
          expect(moveNote(doc, by, pattern, note, { ...g5, tick: Tick(0) })).toBe(false)
          expect(stretchNote(doc, by, pattern, note, 240)).toBe(false)
        })
      ).toBe(0)
    refused(pattern.id, Id('never'))
    refused(Id('nowhere'), id)
    rawMap(doc, 'channels', channel.id).set('deleted', true)
    refused(pattern.id, id)
    rawMap(doc, 'channels', channel.id).set('deleted', false)
    rawMap(doc, 'patterns', pattern.id).set('deleted', true)
    refused(pattern.id, id)
  })

  test('erased goes with the notes alike in channel, tick and key, and with no other', () => {
    const doc = newProject()
    const { channels } = projectOf(doc)
    const { pattern } = parts(doc)
    const [kick, snare] = channels.map(({ id }) => id)
    const notes = rawNotes(doc, pattern.id)
    notes.set('erased', { channel: kick, tick: 480, len: 240, key: 67, vel: 1 })
    notes.set('alike', { channel: kick, tick: 480, len: 960, key: 67, vel: 0.5 })
    notes.set('higher', { channel: kick, tick: 480, len: 240, key: 68, vel: 1 })
    notes.set('later', { channel: kick, tick: 481, len: 240, key: 67, vel: 1 })
    notes.set('snare', { channel: snare, tick: 480, len: 240, key: 67, vel: 1 })
    expect(eraseNotes(doc, by, pattern.id, [Id('erased')])).toBe(true)
    expect(notesOf(doc).map(({ id }) => id)).toEqual(['higher', 'later', 'snare'])
  })

  test('erased once it is gone changes nothing; in a pattern not there, it is refused', () => {
    const doc = newProject()
    const { channel, pattern } = parts(doc)
    addNote(doc, by, pattern.id, channel.id, g5)
    const [{ id }] = notesOf(doc)
    expect(eraseNotes(doc, by, pattern.id, [id])).toBe(true)
    expect(updatesDuring(doc, () => expect(eraseNotes(doc, by, pattern.id, [id, Id('never')])).toBe(true))).toBe(0)
    expect(eraseNotes(doc, by, Id('nowhere'), [id])).toBe(false)
  })

  test('put by two clients apart in one place is two notes; erased by one, it is gone for both', () => {
    const first = newProject()
    const second = new Y.Doc()
    sync(first, second)
    const { channel, pattern } = parts(first)
    expect(addNote(first, by, pattern.id, channel.id, g5)).toBe(true)
    expect(addNote(second, by, pattern.id, channel.id, g5)).toBe(true)
    sync(first, second)
    expect(notesOf(first)).toHaveLength(2)
    expect(eraseNotes(second, by, pattern.id, [notesOf(second)[0].id])).toBe(true)
    sync(first, second)
    expect(notesOf(first)).toEqual([])
    expect(notesOf(second)).toEqual([])
  })
})

test("a pattern's notes are a map of the document's top: an edit of them is one transaction, and needs no mending", () => {
  const doc = newProject()
  const { channel, pattern } = parts(doc)
  // As the pattern's own map held them before.
  rawMap(doc, 'patterns', pattern.id).set('notes', 'x')
  const transactions = { count: 0 }
  const count = () => {
    transactions.count += 1
  }
  doc.on('afterTransaction', count)
  expect(toggleStep(doc, by, pattern.id, channel.id, 1)).toBe(true)
  doc.off('afterTransaction', count)
  expect(transactions.count).toBe(1)
  expect(rawNotes(doc, pattern.id).size).toBe(1)
  expect(notesOf(doc).map(({ tick }) => tick)).toEqual([stepTicks])
  expect(replacementsOf(doc)).toEqual([])
})

test('notes two clients put apart into a pattern new to both stay, each, as the map of them is one for both', () => {
  const first = newProject()
  const second = new Y.Doc()
  sync(first, second)
  const { channel } = parts(first)
  const pattern = Option.getOrThrow(addPattern(first, by))
  sync(first, second)
  expect(toggleStep(first, by, pattern, channel.id, 1)).toBe(true)
  expect(toggleStep(second, by, pattern, channel.id, 2)).toBe(true)
  sync(first, second)
  const ticks = (doc: Y.Doc) =>
    Option.fromUndefinedOr(projectOf(doc).patterns.find(({ id }) => id === pattern)).pipe(
      Option.map(({ notes }) => notes.map(({ tick }) => tick).toSorted((a, b) => a - b))
    )
  expect(ticks(first)).toEqual(Option.some([stepTicks, 2 * stepTicks]))
  expect(ticks(second)).toEqual(ticks(first))
})

test('an edit into a map made anew is two transactions: the map, marked as no editor, then the edit, as its writer', () => {
  const doc = newProjectWithSynth()
  const synth = synthOf(doc)
  const origins: Array<unknown> = []
  const record = (transaction: Y.Transaction) => origins.push(transaction.origin)
  rawMap(doc, 'channels', synth.id, 'instrument').delete('params')
  doc.on('afterTransaction', record)
  expect(setChannelParam(doc, by, synth.id, 'osc1.shape', 1)).toBe(true)
  expect(setChannelParam(doc, by, synth.id, 'osc1.shape', 2)).toBe(true)
  doc.off('afterTransaction', record)
  expect(origins).toHaveLength(3)
  expect(origins[0]).not.toBe(by)
  expect(origins.slice(1)).toEqual([by, by])
  expect(shapeOf(doc)).toBe(2)
  expect(replacementsOf(doc)).toEqual([])
})

test('a map is never mended inside another transaction, which would take the mend as its own', () => {
  const doc = newProjectWithSynth()
  const synth = synthOf(doc)
  rawMap(doc, 'channels', synth.id, 'instrument').set('params', 'broken')
  expect(() => doc.transact(() => setChannelParam(doc, by, synth.id, 'osc1.shape', 1), by)).toThrow(
    'Setup is written in a transaction of its own'
  )
  expect(rawMap(doc, 'channels', synth.id, 'instrument').get('params')).toBe('broken')
})

describe("a channel's parameter", () => {
  test('is set into its range, a choice as the nearest', () => {
    const doc = newProjectWithSynth()
    const synth = synthOf(doc)
    const set = (value: number) => {
      expect(setChannelParam(doc, by, synth.id, 'osc1.shape', value)).toBe(true)
      return shapeOf(doc)
    }
    expect(set(1)).toBe(1)
    expect(set(2.4)).toBe(2)
    expect(set(2.6)).toBe(3)
    expect(set(9)).toBe(4)
    expect(set(-1)).toBe(0)
  })

  test("is refused if it isn't a number, the instrument has no such parameter, or the channel isn't there", () => {
    const doc = newProjectWithSynth()
    const { channel } = parts(doc)
    const synth = synthOf(doc)
    const refused = () => {
      expect(setChannelParam(doc, by, synth.id, 'osc1.shape', Number.NaN)).toBe(false)
      expect(setChannelParam(doc, by, synth.id, 'osc1.shape', Number.POSITIVE_INFINITY)).toBe(false)
      expect(setChannelParam(doc, by, synth.id, 'cutoff', 200)).toBe(false)
      // A sampler has no volume of its own: its channel's sets how loud.
      expect(setChannelParam(doc, by, channel.id, 'volume', 0.5)).toBe(false)
      expect(setChannelParam(doc, by, Id('nobody'), 'osc1.shape', 1)).toBe(false)
    }
    expect(updatesDuring(doc, refused)).toBe(0)
    rawMap(doc, 'channels', synth.id, 'instrument').set('plugin', { id: 99, version: 1 })
    expect(updatesDuring(doc, () => expect(setChannelParam(doc, by, synth.id, 'osc1.shape', 1)).toBe(false))).toBe(0)
  })

  test('of an instrument without parameters, or with something else in their place, is its first', () => {
    brokenWays.forEach((breakIt) => {
      const doc = newProjectWithSynth()
      const synth = synthOf(doc)
      breakIt(rawMap(doc, 'channels', synth.id, 'instrument'), 'params')
      expect(setChannelParam(doc, by, synth.id, 'osc1.shape', 1)).toBe(true)
      expect(shapeOf(doc)).toBe(1)
      expect(replacementsOf(doc)).toEqual([])
    })
  })
})

describe("a channel's strip", () => {
  const stripOf = (doc: Y.Doc) => projectOf(doc).channels[0].strip
  const [volume, pan] = channelStrip

  test("is the engine's, but no louder than the sound as it is, and a new channel's volume knob stands 5.2 dB down", () => {
    expect(channelStrip.map(({ id }) => id)).toEqual(strip.map(({ id }) => id))
    channelStrip.forEach((param, i) => {
      expect(param.min).toBeGreaterThanOrEqual(strip[i].min)
      expect(param.max).toBeLessThanOrEqual(strip[i].max)
    })
    expect(formatValue(volume, volume.max)).toBe('0.0 dB')
    expect(pan).toMatchObject({ min: -1, max: 1 })
    expect(paramPosition(volume, volume.default)).toBeCloseTo(newChannelPosition, 9)
    expect(formatValue(volume, volume.default)).toBe('−5.2 dB')
    expect(pan.default).toBe(0)
  })

  test('starts at its defaults, and each parameter is set into its range on its own', () => {
    const doc = newProject()
    const { channel } = parts(doc)
    expect(stripOf(doc)).toEqual(defaultChannelStrip)
    expect(setChannelStrip(doc, by, channel.id, 'pan', -0.5)).toBe(true)
    expect(stripOf(doc)).toEqual({ ...defaultChannelStrip, pan: -0.5 })
    expect(setChannelStrip(doc, by, channel.id, 'volume', 9)).toBe(true)
    expect(stripOf(doc)).toEqual({ volume: volume.max, pan: -0.5 })
    expect(setChannelStrip(doc, by, channel.id, 'pan', -9)).toBe(true)
    expect(setChannelStrip(doc, by, channel.id, 'volume', -1)).toBe(true)
    expect(stripOf(doc)).toEqual({ volume: volume.min, pan: pan.min })
    expect(replacementsOf(doc)).toEqual([])
  })

  test("is refused if it isn't a number or the channel isn't there", () => {
    const doc = newProject()
    const { channel } = parts(doc)
    const refused = () => {
      expect(setChannelStrip(doc, by, channel.id, 'volume', Number.NaN)).toBe(false)
      expect(setChannelStrip(doc, by, channel.id, 'pan', Number.NEGATIVE_INFINITY)).toBe(false)
      expect(setChannelStrip(doc, by, Id('nobody'), 'pan', 0.5)).toBe(false)
    }
    expect(updatesDuring(doc, refused)).toBe(0)
  })

  test('two clients turning its two knobs at once keep both', () => {
    const [first, second] = [newProject(), new Y.Doc()]
    sync(first, second)
    const { channel } = parts(first)
    expect(setChannelStrip(first, by, channel.id, 'volume', 0.5)).toBe(true)
    expect(setChannelStrip(second, by, channel.id, 'pan', 0.25)).toBe(true)
    sync(first, second)
    expect(stripOf(first)).toEqual({ volume: 0.5, pan: 0.25 })
    expect(stripOf(second)).toEqual({ volume: 0.5, pan: 0.25 })
  })
})

test("a master slot's parameter is set into its range; one not there is refused", () => {
  const doc = newProject()
  const { slot } = parts(doc)
  const value = () => cutoffOf(doc)
  expect(setMasterParam(doc, by, slot.id, 'cutoff', 1200)).toBe(true)
  expect(value()).toBe(1200)
  expect(setMasterParam(doc, by, slot.id, 'cutoff', 5)).toBe(true)
  expect(value()).toBe(cutoff.min)
  expect(updatesDuring(doc, () => expect(setMasterParam(doc, by, Id('nowhere'), 'cutoff', 200)).toBe(false))).toBe(0)
  expect(updatesDuring(doc, () => expect(setMasterParam(doc, by, slot.id, 'volume', 0.5)).toBe(false))).toBe(0)
})

describe('the mixer', () => {
  const insertOf = (doc: Y.Doc, id: string) =>
    Option.getOrElse(Option.fromUndefinedOr(projectOf(doc).inserts.find((insert) => insert.id === id)), () => ({
      id,
      strip: defaultStrip,
      mute: false
    }))
  const volumeTop = Option.getOrThrow(Option.fromUndefinedOr(strip.find(({ id }) => id === 'volume'))).max

  test('a channel goes into an insert, and back into the master; an insert there is not, or a channel, is refused', () => {
    const doc = newProject()
    const { channel } = parts(doc)
    const insert = () => projectOf(doc).channels[0].insert
    expect(setChannelInsert(doc, by, channel.id, Id('3'))).toBe(true)
    expect(insert()).toBe('3')
    expect(setChannelInsert(doc, by, channel.id, Id('master'))).toBe(true)
    expect(insert()).toBe('master')
    const refused = () => {
      ;['0', '501', 'nowhere'].forEach((id) => expect(setChannelInsert(doc, by, channel.id, Id(id))).toBe(false))
      expect(setChannelInsert(doc, by, Id('nobody'), Id('3'))).toBe(false)
    }
    expect(updatesDuring(doc, refused)).toBe(0)
    expect(replacementsOf(doc)).toEqual([])
  })

  test('the master goes nowhere new for a channel the document holds no insert of', () => {
    const doc = newProject()
    const { channel } = parts(doc)
    expect(updatesDuring(doc, () => expect(setChannelInsert(doc, by, channel.id, Id('master'))).toBe(true))).toBe(0)
  })

  test("an insert's strip, the master's too, is set into the engine's range, a parameter on its own", () => {
    const doc = newProject()
    expect(setInsertStrip(doc, by, Id('7'), 'volume', 9)).toBe(true)
    expect(setInsertStrip(doc, by, Id('7'), 'pan', -0.5)).toBe(true)
    expect(insertOf(doc, '7')).toEqual({ id: '7', strip: { volume: volumeTop, pan: -0.5 }, mute: false })
    expect(setInsertStrip(doc, by, Id('master'), 'volume', 0.5)).toBe(true)
    expect(projectOf(doc).master.strip).toEqual({ ...defaultStrip, volume: 0.5 })
    expect(replacementsOf(doc)).toEqual([])
  })

  test("an insert's strip is refused if it isn't a number, the insert isn't there, or there is no project", () => {
    const doc = newProject()
    const empty = new Y.Doc()
    const refused = () => {
      expect(setInsertStrip(doc, by, Id('7'), 'volume', Number.NaN)).toBe(false)
      ;['0', '501', 'nowhere'].forEach((id) => expect(setInsertStrip(doc, by, Id(id), 'pan', 0.5)).toBe(false))
    }
    expect(updatesDuring(doc, refused)).toBe(0)
    expect(updatesDuring(empty, () => expect(setInsertStrip(empty, by, Id('7'), 'pan', 0.5)).toBe(false))).toBe(0)
    expect(createProject(empty, by, drums)).toBe(true)
  })

  test('an insert is muted and unmuted, but not the master', () => {
    const doc = newProject()
    expect(setInsertMute(doc, by, Id('500'), true)).toBe(true)
    expect(insertOf(doc, '500').mute).toBe(true)
    expect(setInsertMute(doc, by, Id('500'), false)).toBe(true)
    expect(insertOf(doc, '500').mute).toBe(false)
    expect(updatesDuring(doc, () => expect(setInsertMute(doc, by, Id('master'), true)).toBe(false))).toBe(0)
  })

  test('the values an insert reads where the document holds none of it are not written', () => {
    const doc = newProject()
    const none = () => {
      expect(setInsertStrip(doc, by, Id('7'), 'volume', 1)).toBe(true)
      expect(setInsertStrip(doc, by, Id('master'), 'pan', 0)).toBe(true)
      expect(setInsertMute(doc, by, Id('7'), false)).toBe(true)
    }
    expect(updatesDuring(doc, none)).toBe(0)
    expect(projectOf(doc).inserts).toEqual([])
  })

  test('two clients writing first into one insert at once keep both, as it is a map of its own', () => {
    const [first, second] = [newProject(), new Y.Doc()]
    sync(first, second)
    expect(setInsertStrip(first, by, Id('4'), 'volume', 0.5)).toBe(true)
    expect(setInsertMute(second, by, Id('4'), true)).toBe(true)
    sync(first, second)
    const both = { id: '4', strip: { ...defaultStrip, volume: 0.5 }, mute: true }
    expect(insertOf(first, '4')).toEqual(both)
    expect(insertOf(second, '4')).toEqual(both)
  })
})

test('a channel is muted and unmuted; one not there is refused', () => {
  const doc = newProject()
  const { channel } = parts(doc)
  expect(setMute(doc, by, channel.id, true)).toBe(true)
  expect(projectOf(doc).channels[0].mute).toBe(true)
  expect(setMute(doc, by, channel.id, false)).toBe(true)
  expect(projectOf(doc).channels[0].mute).toBe(false)
  expect(updatesDuring(doc, () => expect(setMute(doc, by, Id('nobody'), true)).toBe(false))).toBe(0)
})

test('a value the document already holds is not written again', () => {
  const doc = newProjectWithSynth()
  const { channel, slot } = parts(doc)
  const synth = synthOf(doc)
  expect(setChannelParam(doc, by, synth.id, 'osc1.shape', 9)).toBe(true)
  expect(setChannelStrip(doc, by, channel.id, 'pan', 2)).toBe(true)
  expect(setMasterParam(doc, by, slot.id, 'cutoff', 1200)).toBe(true)
  expect(setTempo(doc, by, 1000)).toBe(true)
  const again = () => {
    expect(setChannelParam(doc, by, synth.id, 'osc1.shape', 4)).toBe(true)
    expect(setChannelParam(doc, by, synth.id, 'osc1.shape', 4.4)).toBe(true)
    expect(setChannelStrip(doc, by, channel.id, 'pan', 1)).toBe(true)
    expect(setChannelStrip(doc, by, channel.id, 'pan', 3)).toBe(true)
    expect(setMasterParam(doc, by, slot.id, 'cutoff', 1200)).toBe(true)
    expect(setTempo(doc, by, maxTempo)).toBe(true)
    expect(setTempo(doc, by, 2000)).toBe(true)
    expect(setMute(doc, by, channel.id, false)).toBe(true)
    expect(renameChannel(doc, by, channel.id, ' Kick ')).toBe(true)
  }
  expect(updatesDuring(doc, again)).toBe(0)
})

test('nor is the value a document reads where it holds none: an edit that changes nothing is no step of undo', () => {
  const doc = newProjectWithSynth()
  const { channel } = parts(doc)
  const synth = synthOf(doc)
  ;['mute', 'volume', 'pan'].forEach((key) => rawMap(doc, 'channels', channel.id).delete(key))
  rawMap(doc, 'meta').delete('bpm')
  const none = () => {
    expect(setChannelParam(doc, by, synth.id, 'osc1.shape', plugins.synth.params[0].default)).toBe(true)
    expect(setChannelStrip(doc, by, channel.id, 'volume', defaultChannelStrip.volume)).toBe(true)
    expect(setChannelStrip(doc, by, channel.id, 'pan', 0)).toBe(true)
    expect(setMute(doc, by, channel.id, false)).toBe(true)
    expect(setTempo(doc, by, defaultTempo)).toBe(true)
  }
  expect(updatesDuring(doc, none)).toBe(0)
  expect(setChannelParam(doc, by, synth.id, 'osc1.shape', 0)).toBe(true)
  expect(shapeOf(doc)).toBe(0)
})

test('a broken value is written over even when it reads as the one written', () => {
  const doc = newProject()
  const { channel } = parts(doc)
  rawMap(doc, 'channels', channel.id).set('mute', 'no')
  expect(projectOf(doc).channels[0].mute).toBe(false)
  expect(updatesDuring(doc, () => expect(setMute(doc, by, channel.id, false)).toBe(true))).toBe(1)
  expect(replacementsOf(doc)).toEqual([])
})

test('no tempo is set on a document without a project, which can then still have one', () => {
  const doc = new Y.Doc()
  expect(updatesDuring(doc, () => expect(setTempo(doc, by, 140)).toBe(false))).toBe(0)
  expect(createProject(doc, by, drums)).toBe(true)
})

test("the tempo is set into the engine's range; one that isn't a number is refused", () => {
  const doc = newProject()
  expect(setTempo(doc, by, 140)).toBe(true)
  expect(projectOf(doc).tempo).toBe(140)
  expect(setTempo(doc, by, 1000)).toBe(true)
  expect(projectOf(doc).tempo).toBe(maxTempo)
  expect(setTempo(doc, by, 1)).toBe(true)
  expect(projectOf(doc).tempo).toBe(minTempo)
  expect(updatesDuring(doc, () => expect(setTempo(doc, by, Number.NaN)).toBe(false))).toBe(0)
})

test('each operation is one transaction, and what it writes reads back with nothing replaced', () => {
  const doc = newProjectWithSynth()
  const { channel, pattern, slot } = parts(doc)
  const synth = synthOf(doc)
  const clip = Option.getOrThrow(addClip(doc, by, pattern.id, { track: Id('1'), tick: Tick(0) }))
  // Two notes on one step, as two clients make them: switching it off removes both at once.
  ;['first', 'second'].forEach((id) => rawNotes(doc, pattern.id).set(id, { channel: channel.id, tick: 960 }))
  const operations = [
    () => toggleStep(doc, by, pattern.id, channel.id, 0),
    () => toggleStep(doc, by, pattern.id, channel.id, 0),
    () => toggleStep(doc, by, pattern.id, channel.id, 4),
    () => toggleStep(doc, by, pattern.id, channel.id, 4),
    () => toggleStep(doc, by, pattern.id, channel.id, 5),
    () => addNote(doc, by, pattern.id, channel.id, { tick: Tick(0), key: MidiKey(64), length: 480 }),
    () =>
      eraseNotes(
        doc,
        by,
        pattern.id,
        notesOf(doc).flatMap(({ id, key }) => Option.toArray(Option.liftPredicate(id, () => key === 64)))
      ),
    () => setChannelParam(doc, by, synth.id, 'osc1.shape', 1),
    () => setChannelStrip(doc, by, channel.id, 'pan', 2),
    () => setMasterParam(doc, by, slot.id, 'cutoff', 0),
    () => setMute(doc, by, channel.id, true),
    () => setTempo(doc, by, 600),
    () => renameChannel(doc, by, channel.id, 'Tom'),
    () => deleteChannel(doc, by, synth.id),
    () => moveClip(doc, by, clip, { track: Id('2'), tick: Tick(barTicks) }),
    () => eraseClips(doc, by, [clip])
  ]
  operations.forEach((operation) => {
    const transactions = { count: 0 }
    const count = () => {
      transactions.count += 1
    }
    doc.on('afterTransaction', count)
    expect(operation()).toBe(true)
    doc.off('afterTransaction', count)
    expect(transactions.count).toBe(1)
  })
  expect(replacementsOf(doc)).toEqual([])
})

describe('a channel added', () => {
  const names = (doc: Y.Doc) => projectOf(doc).channels.map(({ name }) => name)

  test('comes after the others with a synth at its defaults, named after it with a name no other channel has', () => {
    const doc = newProject()
    expect(addChannel(doc, by)).toBe(true)
    expect(addChannel(doc, by)).toBe(true)
    expect(names(doc)).toEqual([...drums.map(({ name }) => name), 'Synth', 'Synth 2'])
    const added = projectOf(doc).channels.at(-1)
    expect(added?.mute).toBe(false)
    const instrument = Option.flatMap(Option.fromUndefinedOr(added), ({ instrument }) => instrument)
    expect(Option.map(instrument, ({ name, params }) => ({ name, params }))).toEqual(
      Option.some({ name: 'synth', params: synthDefaults })
    )
    // A name taken otherwise, and one a deleted channel had, which is free again.
    const [kick, snare] = projectOf(doc).channels
    rawMap(doc, 'channels', kick.id).set('name', 'Synth 3')
    rawMap(doc, 'channels', snare.id).set('deleted', true)
    rawMap(doc, 'channels', snare.id).set('name', 'Synth 4')
    expect(addChannel(doc, by)).toBe(true)
    expect(names(doc).at(-1)).toBe('Synth 4')
  })

  test("comes after the others even if some of their places can't be read, and first if none can", () => {
    const doc = newProject()
    const [kick] = projectOf(doc).channels
    // Past every index, as `~` sorts after the digits and letters they are made of.
    rawMap(doc, 'channels', kick.id).set('order', '~broken')
    expect(addChannel(doc, by)).toBe(true)
    expect(names(doc).slice(-2)).toEqual(['Synth', 'Kick'])
    const unreadable = newProject()
    projectOf(unreadable).channels.forEach(({ id }) => {
      rawMap(unreadable, 'channels', id).set('order', '')
    })
    expect(addChannel(unreadable, by)).toBe(true)
    expect(names(unreadable).at(-1)).toBe('Synth')
  })

  test('is refused in a document without a project', () => {
    const doc = new Y.Doc()
    expect(updatesDuring(doc, () => expect(addChannel(doc, by)).toBe(false))).toBe(0)
  })
})

describe('a channel renamed', () => {
  test('takes the name without the spaces around it, one another channel has too', () => {
    const doc = newProject()
    const [kick, snare] = projectOf(doc).channels
    expect(renameChannel(doc, by, kick.id, '  Big kick\t')).toBe(true)
    expect(renameChannel(doc, by, snare.id, 'Big kick')).toBe(true)
    expect(
      projectOf(doc)
        .channels.map(({ name }) => name)
        .slice(0, 2)
    ).toEqual(['Big kick', 'Big kick'])
  })

  test("keeps its name for one that is empty or only spaces, and is refused if it isn't there or is deleted", () => {
    const doc = newProject()
    const [kick, snare] = projectOf(doc).channels
    rawMap(doc, 'channels', snare.id).set('deleted', true)
    const refused = () => {
      expect(renameChannel(doc, by, kick.id, '')).toBe(false)
      expect(renameChannel(doc, by, kick.id, ' \n ')).toBe(false)
      expect(renameChannel(doc, by, snare.id, 'Tom')).toBe(false)
      expect(renameChannel(doc, by, Id('nobody'), 'Tom')).toBe(false)
    }
    expect(updatesDuring(doc, refused)).toBe(0)
    expect(projectOf(doc).channels[0].name).toBe('Kick')
  })

  test('writes over a name that is something else, which reads as none', () => {
    const doc = newProject()
    const { channel } = parts(doc)
    rawMap(doc, 'channels', channel.id).set('name', 7)
    expect(renameChannel(doc, by, channel.id, 'Kick')).toBe(true)
    expect(projectOf(doc).channels[0].name).toBe('Kick')
    expect(replacementsOf(doc)).toEqual([])
  })
})

describe('a channel deleted', () => {
  test('is marked so: its place, strip, instrument and notes stay in the document, and only it is gone', () => {
    const doc = newProject()
    const { channel, pattern } = parts(doc)
    expect(toggleStep(doc, by, pattern.id, channel.id, 3)).toBe(true)
    expect(setChannelStrip(doc, by, channel.id, 'pan', 2)).toBe(true)
    const before = rawMap(doc, 'channels', channel.id).toJSON()
    expect(deleteChannel(doc, by, channel.id)).toBe(true)
    expect(projectOf(doc).channels.map(({ name }) => name)).toEqual(drums.slice(1).map(({ name }) => name))
    expect(rawMap(doc, 'channels', channel.id).toJSON()).toEqual({ ...before, deleted: true })
    expect(notesOn(doc, channel.id, 3)).toHaveLength(1)
  })

  test('again, or not there, is refused', () => {
    const doc = newProject()
    const { channel } = parts(doc)
    expect(deleteChannel(doc, by, channel.id)).toBe(true)
    const refused = () => {
      expect(deleteChannel(doc, by, channel.id)).toBe(false)
      expect(deleteChannel(doc, by, Id('nobody'))).toBe(false)
    }
    expect(updatesDuring(doc, refused)).toBe(0)
  })

  test('keeps its place: one added after it goes after it, and it comes back before that one', () => {
    const doc = newProject()
    const [, , , clap] = projectOf(doc).channels
    const ids = () => projectOf(doc).channels.map(({ id }) => id)
    expect(deleteChannel(doc, by, clap.id)).toBe(true)
    expect(addChannel(doc, by)).toBe(true)
    const synth = ids().at(-1)
    // As an undo of the deletion writes it.
    rawMap(doc, 'channels', clap.id).set('deleted', false)
    expect(ids().slice(-2)).toEqual([clap.id, synth])
    const places = ids().map((id) => rawMap(doc, 'channels', id).get('order'))
    expect(new Set(places).size).toBe(places.length)
  })

  test('to the last leaves a project with no channels, which can have one again', () => {
    const doc = newProject()
    projectOf(doc).channels.forEach(({ id }) => {
      expect(deleteChannel(doc, by, id)).toBe(true)
    })
    expect(projectOf(doc).channels).toEqual([])
    expect(addChannel(doc, by)).toBe(true)
    expect(projectOf(doc).channels.map(({ name }) => name)).toEqual(['Synth'])
  })
})

describe('a pattern added', () => {
  const patternsOf = (doc: Y.Doc) => projectOf(doc).patterns

  test('comes after the others and is named "Pattern" and the first number no live pattern has', () => {
    const doc = newProject()
    const [first] = patternsOf(doc)
    const added = addPattern(doc, by)
    expect(Option.map(added, () => patternsOf(doc).map(({ id }) => id))).toEqual(
      Option.map(added, (id) => [first.id, id])
    )
    expect(Option.isSome(addPattern(doc, by))).toBe(true)
    expect(patternsOf(doc).map(({ name, notes }) => ({ name, notes }))).toEqual([
      { name: 'Pattern 1', notes: [] },
      { name: 'Pattern 2', notes: [] },
      { name: 'Pattern 3', notes: [] }
    ])
    // A name a deleted pattern had is free again.
    rawMap(doc, 'patterns', first.id).set('deleted', true)
    expect(Option.isSome(addPattern(doc, by))).toBe(true)
    expect(patternsOf(doc).map(({ name }) => name)).toEqual(['Pattern 2', 'Pattern 3', 'Pattern 1'])
    expect(replacementsOf(doc)).toEqual([])
  })

  test('comes after a deleted one too, which comes back in its place', () => {
    const doc = newProject()
    const deleted = Option.getOrThrow(addPattern(doc, by))
    rawMap(doc, 'patterns', deleted).set('deleted', true)
    const added = Option.getOrThrow(addPattern(doc, by))
    rawMap(doc, 'patterns', deleted).set('deleted', false)
    expect(
      patternsOf(doc)
        .map(({ id }) => id)
        .slice(1)
    ).toEqual([deleted, added])
  })

  test('is set up deleted, in a transaction no history tracks, and then its writer brings it in', () => {
    const doc = newProject()
    const written: Array<{ readonly origin: unknown; readonly patterns: Record<string, { deleted?: unknown }> }> = []
    const record = ({ origin }: Y.Transaction) => written.push({ origin, patterns: doc.getMap('patterns').toJSON() })
    doc.on('afterTransaction', record)
    const added = Option.getOrThrow(addPattern(doc, by))
    doc.off('afterTransaction', record)
    expect(written.map(({ origin, patterns }) => ({ by: origin === by, deleted: patterns[added]?.deleted }))).toEqual([
      { by: false, deleted: true },
      { by: true, deleted: false }
    ])
    expect(() => doc.transact(() => addPattern(doc, by), by)).toThrow('Setup is written in a transaction of its own')
    expect(projectOf(doc).patterns.map(({ id }) => id)).toEqual([parts(doc).pattern.id, added])
    expect(replacementsOf(doc)).toEqual([])
  })

  test('is refused in a document without a project', () => {
    const doc = new Y.Doc()
    expect(updatesDuring(doc, () => expect(addPattern(doc, by)).toEqual(Option.none()))).toBe(0)
  })
})

describe('a pattern renamed', () => {
  test('takes the name without the spaces around it, one another pattern has too', () => {
    const doc = newProject()
    const { pattern } = parts(doc)
    const added = Option.getOrThrow(addPattern(doc, by))
    expect(renamePattern(doc, by, pattern.id, '  Intro\t')).toBe(true)
    expect(renamePattern(doc, by, added, 'Intro')).toBe(true)
    expect(projectOf(doc).patterns.map(({ name }) => name)).toEqual(['Intro', 'Intro'])
  })

  test("keeps its name for one that is empty or only spaces, and is refused if it isn't there or is deleted", () => {
    const doc = newProject()
    const { pattern } = parts(doc)
    const deleted = Option.getOrThrow(addPattern(doc, by))
    rawMap(doc, 'patterns', deleted).set('deleted', true)
    const refused = () => {
      expect(renamePattern(doc, by, pattern.id, '')).toBe(false)
      expect(renamePattern(doc, by, pattern.id, ' \n ')).toBe(false)
      expect(renamePattern(doc, by, deleted, 'Intro')).toBe(false)
      expect(renamePattern(doc, by, Id('nobody'), 'Intro')).toBe(false)
    }
    expect(updatesDuring(doc, refused)).toBe(0)
    expect(projectOf(doc).patterns[0].name).toBe('Pattern 1')
  })
})

describe('a pattern cloned', () => {
  const placed = (doc: Y.Doc) =>
    projectOf(doc).patterns.map(({ name, notes }) => ({
      name,
      // By ID, as notes read: a copy's are new.
      ticks: notes.map(({ tick }) => tick / stepTicks).toSorted((a, b) => a - b)
    }))

  test('comes right after it, before a deleted one there too, with its notes, named as a clone', () => {
    const doc = newProject()
    const { channel, pattern } = parts(doc)
    const deleted = Option.getOrThrow(addPattern(doc, by))
    const next = Option.getOrThrow(addPattern(doc, by))
    expect(toggleStep(doc, by, pattern.id, channel.id, 2)).toBe(true)
    expect(toggleStep(doc, by, pattern.id, channel.id, 5)).toBe(true)
    rawMap(doc, 'patterns', deleted).set('deleted', true)
    const clone = Option.getOrThrow(clonePattern(doc, by, pattern.id))
    expect(placed(doc)).toEqual([
      { name: 'Pattern 1', ticks: [2, 5] },
      { name: 'Pattern 1 #2', ticks: [2, 5] },
      { name: 'Pattern 3', ticks: [] }
    ])
    rawMap(doc, 'patterns', deleted).set('deleted', false)
    expect(projectOf(doc).patterns.map(({ id }) => id)).toEqual([pattern.id, clone, deleted, next])
    expect(replacementsOf(doc)).toEqual([])
  })

  test("has notes of its own: a step put in the copy isn't in the pattern", () => {
    const doc = newProject()
    const { channel, pattern } = parts(doc)
    expect(toggleStep(doc, by, pattern.id, channel.id, 0)).toBe(true)
    const clone = Option.getOrThrow(clonePattern(doc, by, pattern.id))
    const [original, copy] = projectOf(doc).patterns
    expect(copy.notes.map(({ id }) => id)).not.toContain(original.notes[0].id)
    expect(toggleStep(doc, by, clone, channel.id, 0)).toBe(true)
    expect(toggleStep(doc, by, clone, channel.id, 1)).toBe(true)
    expect(placed(doc)).toEqual([
      { name: 'Pattern 1', ticks: [0] },
      { name: 'Pattern 1 #2', ticks: [1] }
    ])
  })

  test('by the first number from 2 no live pattern has, and a copy of a copy by the same name', () => {
    const doc = newProject()
    const { pattern } = parts(doc)
    const second = Option.getOrThrow(clonePattern(doc, by, pattern.id))
    expect(Option.isSome(clonePattern(doc, by, pattern.id))).toBe(true)
    expect(Option.isSome(clonePattern(doc, by, second))).toBe(true)
    expect(placed(doc).map(({ name }) => name)).toEqual(['Pattern 1', 'Pattern 1 #3', 'Pattern 1 #2', 'Pattern 1 #4'])
    rawMap(doc, 'patterns', second).set('deleted', true)
    expect(Option.isSome(clonePattern(doc, by, pattern.id))).toBe(true)
    expect(placed(doc).map(({ name }) => name)).toEqual(['Pattern 1', 'Pattern 1 #2', 'Pattern 1 #3', 'Pattern 1 #4'])
  })

  test("comes after them all where its place or the next one can't be read", () => {
    const doc = newProject()
    const { pattern } = parts(doc)
    const last = Option.getOrThrow(addPattern(doc, by))
    rawMap(doc, 'patterns', pattern.id).set('order', '')
    expect(Option.isSome(clonePattern(doc, by, pattern.id))).toBe(true)
    expect(placed(doc).map(({ name }) => name)).toEqual(['Pattern 1', 'Pattern 2', 'Pattern 1 #2'])
    expect(projectOf(doc).patterns[1].id).toBe(last)
  })

  test("is refused if it isn't there or is deleted", () => {
    const doc = newProject()
    const deleted = Option.getOrThrow(addPattern(doc, by))
    rawMap(doc, 'patterns', deleted).set('deleted', true)
    const refused = () => {
      expect(clonePattern(doc, by, deleted)).toEqual(Option.none())
      expect(clonePattern(doc, by, Id('nobody'))).toEqual(Option.none())
    }
    expect(updatesDuring(doc, refused)).toBe(0)
  })
})

describe('a pattern deleted', () => {
  test('is marked so: its place and notes stay in the document, and only it is gone', () => {
    const doc = newProject()
    const { channel, pattern } = parts(doc)
    const added = Option.getOrThrow(addPattern(doc, by))
    expect(toggleStep(doc, by, pattern.id, channel.id, 3)).toBe(true)
    const before = rawMap(doc, 'patterns', pattern.id).toJSON()
    expect(deletePattern(doc, by, pattern.id)).toBe(true)
    expect(projectOf(doc).patterns.map(({ id }) => id)).toEqual([added])
    expect(rawMap(doc, 'patterns', pattern.id).toJSON()).toEqual({ ...before, deleted: true })
    expect(rawNotes(doc, pattern.id).size).toBe(1)
  })

  test('is refused for the last live one, again, or not there', () => {
    const doc = newProject()
    const { pattern } = parts(doc)
    const added = Option.getOrThrow(addPattern(doc, by))
    expect(deletePattern(doc, by, added)).toBe(true)
    const refused = () => {
      expect(deletePattern(doc, by, pattern.id)).toBe(false)
      expect(deletePattern(doc, by, added)).toBe(false)
      expect(deletePattern(doc, by, Id('nobody'))).toBe(false)
    }
    expect(updatesDuring(doc, refused)).toBe(0)
    expect(projectOf(doc).patterns.map(({ id }) => id)).toEqual([pattern.id])
  })
})

describe('a clip', () => {
  const clipsOf = (doc: Y.Doc) => projectOf(doc).clips
  const place = (track: string, bar: number) => ({ track: Id(track), tick: Tick(bar * barTicks) })

  test('added is one of the live pattern at the place, set up deleted and then brought in by its writer', () => {
    const doc = newProject()
    const { pattern } = parts(doc)
    const written: Array<{ readonly origin: unknown; readonly deleted: unknown }> = []
    const record = ({ origin }: Y.Transaction) =>
      written.push({ origin, deleted: Object.values(doc.getMap('clips').toJSON())[0]?.deleted })
    doc.on('afterTransaction', record)
    const added = Option.getOrThrow(addClip(doc, by, pattern.id, place('3', 2)))
    doc.off('afterTransaction', record)
    expect(written.map(({ origin, deleted }) => ({ by: origin === by, deleted }))).toEqual([
      { by: false, deleted: true },
      { by: true, deleted: false }
    ])
    expect(clipsOf(doc)).toEqual([
      { id: added, track: '3', tick: 2 * barTicks, pattern: pattern.id, ownLength: Option.none(), offset: 0 }
    ])
    expect(rawMap(doc, 'clips', added).toJSON()).toEqual({
      track: '3',
      bounds: { tick: 2 * barTicks },
      pattern: pattern.id,
      deleted: false
    })
    expect(replacementsOf(doc)).toEqual([])
  })

  test("is refused for a pattern deleted or not there, or a track the arrangement hasn't", () => {
    const doc = newProject()
    const { pattern } = parts(doc)
    const deleted = Option.getOrThrow(addPattern(doc, by))
    expect(deletePattern(doc, by, deleted)).toBe(true)
    const refused = () => {
      ;[deleted, Id('nobody')].forEach((gone) => expect(addClip(doc, by, gone, place('1', 0))).toEqual(Option.none()))
      ;['0', '501', 'x', ''].forEach((track) =>
        expect(addClip(doc, by, pattern.id, place(track, 0))).toEqual(Option.none())
      )
    }
    expect(updatesDuring(doc, refused)).toBe(0)
    expect(clipsOf(doc)).toEqual([])
  })

  test('moved writes only what changes: its track, its start, or both', () => {
    const doc = newProject()
    const { pattern } = parts(doc)
    const clip = Option.getOrThrow(addClip(doc, by, pattern.id, place('1', 0)))
    const raw = () => rawMap(doc, 'clips', clip).toJSON()
    expect(updatesDuring(doc, () => expect(moveClip(doc, by, clip, place('1', 0))).toBe(true))).toBe(0)
    expect(moveClip(doc, by, clip, place('4', 0))).toBe(true)
    expect(raw()).toMatchObject({ track: '4', bounds: { tick: 0 } })
    expect(moveClip(doc, by, clip, place('4', 3))).toBe(true)
    expect(moveClip(doc, by, clip, place('500', 1))).toBe(true)
    expect(clipsOf(doc)).toEqual([
      { id: clip, track: '500', tick: barTicks, pattern: pattern.id, ownLength: Option.none(), offset: 0 }
    ])
    expect(replacementsOf(doc)).toEqual([])
    // A broken start is written over, though it reads as the one written.
    rawMap(doc, 'clips', clip).set('bounds', { tick: barTicks - 0.4 })
    expect(updatesDuring(doc, () => expect(moveClip(doc, by, clip, place('500', 1))).toBe(true))).toBe(1)
    expect(raw()).toMatchObject({ bounds: { tick: barTicks } })
    expect(replacementsOf(doc)).toEqual([])
  })

  test("moved is refused for one erased, not there or of a deleted pattern, to a track the arrangement hasn't, or where a length of its own ends too late", () => {
    const doc = newProject()
    const { pattern } = parts(doc)
    const clip = Option.getOrThrow(addClip(doc, by, pattern.id, place('1', 0)))
    const long = Option.getOrThrow(addClip(doc, by, pattern.id, place('6', 0)))
    expect(resizeClip(doc, by, long, 3 * barTicks)).toBe(true)
    const lastBar = Math.floor(lastTick / barTicks)
    const erased = Option.getOrThrow(addClip(doc, by, pattern.id, place('2', 0)))
    expect(eraseClips(doc, by, [erased])).toBe(true)
    const other = Option.getOrThrow(addPattern(doc, by))
    const hidden = Option.getOrThrow(addClip(doc, by, other, place('3', 0)))
    expect(deletePattern(doc, by, other)).toBe(true)
    const refused = () => {
      expect(moveClip(doc, by, hidden, place('4', 0))).toBe(false)
      expect(moveClip(doc, by, erased, place('3', 0))).toBe(false)
      expect(moveClip(doc, by, Id('nobody'), place('3', 0))).toBe(false)
      expect(moveClip(doc, by, clip, place('501', 0))).toBe(false)
      expect(moveClip(doc, by, long, place('6', lastBar - 1))).toBe(false)
    }
    expect(updatesDuring(doc, refused)).toBe(0)
    // One as long as its pattern goes there, its end past the latest one, as the pattern may grow and shrink.
    expect(moveClip(doc, by, clip, place('1', lastBar - 1))).toBe(true)
  })

  test('made longer or shorter takes a length of its own, kept as it moves; the length it has writes nothing', () => {
    const doc = newProject()
    const { pattern } = parts(doc)
    const clip = Option.getOrThrow(addClip(doc, by, pattern.id, place('1', 0)))
    const raw = () => rawMap(doc, 'clips', clip).toJSON()
    const ownLengths = () => clipsOf(doc).map(({ ownLength }) => ownLength)
    expect(resizeClip(doc, by, clip, 3 * barTicks)).toBe(true)
    expect(raw()).toMatchObject({ bounds: { tick: 0, length: 3 * barTicks } })
    expect(updatesDuring(doc, () => expect(resizeClip(doc, by, clip, 3 * barTicks)).toBe(true))).toBe(0)
    expect(moveClip(doc, by, clip, place('2', 4))).toBe(true)
    expect(raw()).toMatchObject({ track: '2', bounds: { tick: 4 * barTicks, length: 3 * barTicks } })
    // As long as its pattern now, though: a length of its own all the same, kept as the pattern grows.
    expect(resizeClip(doc, by, clip, barTicks)).toBe(true)
    expect(ownLengths()).toEqual([Option.some(barTicks)])
    expect(replacementsOf(doc)).toEqual([])
  })

  test('trimmed at its start takes its start, its length and its offset together, kept as it moves and resizes', () => {
    const doc = newProject()
    const { pattern } = parts(doc)
    const clip = Option.getOrThrow(addClip(doc, by, pattern.id, place('1', 2)))
    const raw = () => rawMap(doc, 'clips', clip).toJSON()
    const span = { tick: Tick(3 * barTicks), length: 2 * barTicks, offset: barTicks / 2 }
    expect(trimClip(doc, by, clip, span)).toBe(true)
    expect(raw()).toMatchObject({ bounds: { tick: 3 * barTicks, length: 2 * barTicks, offset: barTicks / 2 } })
    expect(updatesDuring(doc, () => expect(trimClip(doc, by, clip, span)).toBe(true))).toBe(0)
    expect(moveClip(doc, by, clip, place('2', 0))).toBe(true)
    expect(resizeClip(doc, by, clip, barTicks)).toBe(true)
    expect(raw()).toMatchObject({ bounds: { tick: 0, length: barTicks, offset: barTicks / 2 } })
    // From a round's start, the document holds no offset.
    expect(trimClip(doc, by, clip, { ...span, offset: 0 })).toBe(true)
    expect(raw()).toMatchObject({ bounds: { tick: 3 * barTicks, length: 2 * barTicks } })
    expect(Object.keys(raw().bounds)).toEqual(['tick', 'length'])
    expect(replacementsOf(doc)).toEqual([])
  })

  test('trimmed is refused for a start, length or offset out of range or not whole, or one not live', () => {
    const doc = newProject()
    const { pattern } = parts(doc)
    const clip = Option.getOrThrow(addClip(doc, by, pattern.id, place('1', 2)))
    const erased = Option.getOrThrow(addClip(doc, by, pattern.id, place('2', 0)))
    expect(eraseClips(doc, by, [erased])).toBe(true)
    const span = { tick: Tick(barTicks), length: barTicks, offset: 0 }
    const refused = () => {
      // Past the brand, as a client without types could send them.
      ;[
        { tick: -barTicks as Tick },
        { tick: 0.5 as Tick },
        { length: 0 },
        { tick: Tick(lastTick), length: 2 },
        { offset: -lastTick - 1 },
        { offset: 0.5 },
        { offset: lastTick + 1 }
      ].forEach((wrong) => expect(trimClip(doc, by, clip, { ...span, ...wrong })).toBe(false))
      ;[erased, Id('nobody')].forEach((gone) => expect(trimClip(doc, by, gone, span)).toBe(false))
    }
    expect(updatesDuring(doc, refused)).toBe(0)
  })

  test('resized is refused for a length not whole, under a tick or ending too late, or one not live', () => {
    const doc = newProject()
    const { pattern } = parts(doc)
    const clip = Option.getOrThrow(addClip(doc, by, pattern.id, place('1', 2)))
    const erased = Option.getOrThrow(addClip(doc, by, pattern.id, place('2', 0)))
    expect(eraseClips(doc, by, [erased])).toBe(true)
    const other = Option.getOrThrow(addPattern(doc, by))
    const hidden = Option.getOrThrow(addClip(doc, by, other, place('3', 0)))
    expect(deletePattern(doc, by, other)).toBe(true)
    const refused = () => {
      // From its start at bar 2, the latest end, the tick after the last, is so far away.
      const longest = lastTick + 1 - 2 * barTicks
      ;[0, -barTicks, 1.5, Number.NaN, longest + 1].forEach((length) =>
        expect(resizeClip(doc, by, clip, length)).toBe(false)
      )
      ;[hidden, erased, Id('nobody')].forEach((gone) => expect(resizeClip(doc, by, gone, barTicks)).toBe(false))
    }
    expect(updatesDuring(doc, refused)).toBe(0)
    expect(resizeClip(doc, by, clip, lastTick + 1 - 2 * barTicks)).toBe(true)
  })

  test('erased is marked so, all it holds left; one not live among those given is passed over', () => {
    const doc = newProject()
    const { pattern } = parts(doc)
    const [first, second] = [0, 1].map((bar) => Option.getOrThrow(addClip(doc, by, pattern.id, place('1', bar))))
    const before = rawMap(doc, 'clips', first).toJSON()
    expect(eraseClips(doc, by, [first, Id('nobody')])).toBe(true)
    expect(rawMap(doc, 'clips', first).toJSON()).toEqual({ ...before, deleted: true })
    expect(clipsOf(doc).map(({ id }) => id)).toEqual([second])
    expect(updatesDuring(doc, () => expect(eraseClips(doc, by, [first])).toBe(true))).toBe(0)
    expect(updatesDuring(new Y.Doc(), () => expect(eraseClips(new Y.Doc(), by, [second])).toBe(false))).toBe(0)
  })

  test('of a deleted pattern is left out, and back with it', () => {
    const doc = newProject()
    const { pattern } = parts(doc)
    const other = Option.getOrThrow(addPattern(doc, by))
    const clip = Option.getOrThrow(addClip(doc, by, other, place('1', 0)))
    expect(deletePattern(doc, by, other)).toBe(true)
    expect(clipsOf(doc)).toEqual([])
    rawMap(doc, 'patterns', other).set('deleted', false)
    expect(clipsOf(doc).map(({ id }) => id)).toEqual([clip])
    expect(Option.isSome(addClip(doc, by, pattern.id, place('1', 0)))).toBe(true)
  })
})
