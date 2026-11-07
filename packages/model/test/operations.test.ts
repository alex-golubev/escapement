import {
  defaultStrip,
  defaultTempo,
  formatValue,
  lastTick,
  MidiKey,
  maxTempo,
  minTempo,
  newTrackPosition,
  paramPosition,
  plugins,
  strip,
  Tick
} from '@escapement/engine-description'
import { Option } from 'effect'
import { describe, expect, test } from 'vitest'
import * as Y from 'yjs'
import {
  addClip,
  addNote,
  addTrack,
  barTicks,
  createProject,
  defaultNote,
  defaultTrackStrip,
  deleteTrack,
  eraseClips,
  eraseNotes,
  Id,
  moveClip,
  moveNote,
  renameTrack,
  resizeClip,
  setInsertMute,
  setInsertStrip,
  setMasterParam,
  setMute,
  setTempo,
  setTrackInsert,
  setTrackParam,
  setTrackStrip,
  stretchNote,
  trackStrip,
  trimClip
} from '../src'
import {
  addDrum,
  brokenWays,
  by,
  cutoffOf,
  drums,
  emptyProject,
  newProject,
  newProjectWithSynth,
  parts,
  projectOf,
  rawMap,
  rawNotes,
  replacementsOf,
  shapeOf,
  sync,
  synthDefaults,
  synthOf,
  updatesDuring
} from './project'

const [cutoff] = plugins.filter.params

/** The notes of the first clip's pattern. */
const notesOf = (doc: Y.Doc) =>
  Option.getOrElse(
    Option.fromUndefinedOr(projectOf(doc).patterns.find(({ id }) => id === parts(doc).clip.pattern)),
    () => ({ notes: [] })
  ).notes

describe('a note', () => {
  const g5 = { tick: Tick(480), key: MidiKey(67), length: 720 }

  test("put is a new note of the clip's pattern where it starts, as high and long as asked, at full strength", () => {
    const doc = newProject()
    const { clip } = parts(doc)
    expect(addNote(doc, by, clip.id, g5)).toBe(true)
    expect(notesOf(doc)).toEqual([{ id: expect.any(String), ...g5, velocity: defaultNote.velocity }])
    expect(rawNotes(doc, clip.pattern).size).toBe(1)
    expect(replacementsOf(doc)).toEqual([])
  })

  test('put last is the one that ends by the tick after the last', () => {
    const doc = newProject()
    const { clip } = parts(doc)
    expect(addNote(doc, by, clip.id, { ...g5, tick: Tick(lastTick), length: 1 })).toBe(true)
    expect(replacementsOf(doc)).toEqual([])
  })

  test.each([
    ['of no length', { length: 0 }],
    ['of a length between two ticks', { length: 1.5 }],
    ['of a length that is not a number', { length: Number.NaN }],
    ['ending past the last tick', { tick: Tick(lastTick), length: 2 }]
  ])('%s is refused', (_, changed) => {
    const doc = newProject()
    const { clip } = parts(doc)
    const note = { ...g5, ...changed }
    expect(updatesDuring(doc, () => expect(addNote(doc, by, clip.id, note)).toBe(false))).toBe(0)
  })

  test('put into a clip not there, erased, or on a track deleted, is refused', () => {
    const doc = newProject()
    const { track, clip } = parts(doc)
    expect(updatesDuring(doc, () => expect(addNote(doc, by, Id('nowhere'), g5)).toBe(false))).toBe(0)
    rawMap(doc, 'tracks', track.id).set('deleted', true)
    expect(updatesDuring(doc, () => expect(addNote(doc, by, clip.id, g5)).toBe(false))).toBe(0)
    rawMap(doc, 'tracks', track.id).set('deleted', false)
    rawMap(doc, 'clips', clip.id).set('deleted', true)
    expect(updatesDuring(doc, () => expect(addNote(doc, by, clip.id, g5)).toBe(false))).toBe(0)
  })

  test('put where a note starts as high takes its place; one higher stays', () => {
    const doc = newProject()
    const { clip } = parts(doc)
    const notes = rawNotes(doc, clip.pattern)
    notes.set('there', { tick: 480, len: 240, key: 67, vel: 0.5 })
    notes.set('higher', { tick: 480, len: 240, key: 68, vel: 1 })
    expect(addNote(doc, by, clip.id, g5)).toBe(true)
    expect(notesOf(doc).map(({ id, key, length }) => ({ id, key, length }))).toEqual(
      expect.arrayContaining([
        { id: expect.any(String), key: g5.key, length: g5.length },
        { id: 'higher', key: 68, length: 240 }
      ])
    )
    expect(notesOf(doc)).toHaveLength(2)
  })

  test('of another clip are its own: one put into the first is not in the second', () => {
    const doc = newProject()
    const { track, clip } = parts(doc)
    const other = Option.getOrThrow(addClip(doc, by, { track: track.id, tick: Tick(barTicks) }))
    expect(addNote(doc, by, other, g5)).toBe(true)
    const counts = projectOf(doc).patterns.map(({ id, notes }) => ({ first: id === clip.pattern, notes: notes.length }))
    expect(counts.toSorted((a, b) => Number(b.first) - Number(a.first))).toEqual([
      { first: true, notes: 0 },
      { first: false, notes: 1 }
    ])
  })

  test('moved starts and is as high as asked, the same note, as long and as strong', () => {
    const doc = newProject()
    const { clip } = parts(doc)
    addNote(doc, by, clip.id, g5)
    const [{ id }] = notesOf(doc)
    const to = { tick: Tick(960), key: MidiKey(60) }
    expect(moveNote(doc, by, clip.id, id, to)).toBe(true)
    expect(notesOf(doc)).toEqual([{ id, ...to, length: g5.length, velocity: defaultNote.velocity }])
    expect(replacementsOf(doc)).toEqual([])
  })

  test('stretched is as long as asked, where it was, the same note, as strong', () => {
    const doc = newProject()
    const { clip } = parts(doc)
    addNote(doc, by, clip.id, g5)
    const [{ id }] = notesOf(doc)
    expect(stretchNote(doc, by, clip.id, id, 240)).toBe(true)
    expect(notesOf(doc)).toEqual([{ id, ...g5, length: 240, velocity: defaultNote.velocity }])
  })

  test('moved takes the notes in its place with it, each as long, and takes the place of the notes where it lands', () => {
    const doc = newProject()
    const { clip } = parts(doc)
    const notes = rawNotes(doc, clip.pattern)
    notes.set('moved', { tick: 480, len: 240, key: 67, vel: 1 })
    notes.set('copy', { tick: 480, len: 960, key: 67, vel: 0.5 })
    notes.set('higher', { tick: 480, len: 240, key: 68, vel: 1 })
    notes.set('there', { tick: 0, len: 240, key: 60, vel: 1 })
    const to = { tick: Tick(0), key: MidiKey(60) }
    expect(moveNote(doc, by, clip.id, Id('moved'), to)).toBe(true)
    expect(notesOf(doc).map(({ id, tick, key, length, velocity }) => ({ id, tick, key, length, velocity }))).toEqual([
      { id: 'copy', ...to, length: 960, velocity: 0.5 },
      { id: 'higher', tick: 480, key: 68, length: 240, velocity: 1 },
      { id: 'moved', ...to, length: 240, velocity: 1 }
    ])
  })

  test('stretched takes the notes in its place to its length, and no other', () => {
    const doc = newProject()
    const { clip } = parts(doc)
    const notes = rawNotes(doc, clip.pattern)
    notes.set('stretched', { tick: 480, len: 240, key: 67, vel: 1 })
    notes.set('copy', { tick: 480, len: 960, key: 67, vel: 0.5 })
    notes.set('higher', { tick: 480, len: 240, key: 68, vel: 1 })
    expect(stretchNote(doc, by, clip.id, Id('stretched'), 480)).toBe(true)
    expect(notesOf(doc).map(({ id, length }) => ({ id, length }))).toEqual([
      { id: 'copy', length: 480 },
      { id: 'higher', length: 240 },
      { id: 'stretched', length: 480 }
    ])
  })

  test('moved where it is, or stretched to its length, changes nothing', () => {
    const doc = newProject()
    const { clip } = parts(doc)
    addNote(doc, by, clip.id, g5)
    const [{ id }] = notesOf(doc)
    const unchanged = () => {
      expect(moveNote(doc, by, clip.id, id, g5)).toBe(true)
      expect(stretchNote(doc, by, clip.id, id, g5.length)).toBe(true)
    }
    expect(updatesDuring(doc, unchanged)).toBe(0)
  })

  test.each([
    [
      'moved to end past the last tick',
      (doc: Y.Doc, clip: Id, id: Id) => moveNote(doc, by, clip, id, { tick: Tick(lastTick), key: g5.key })
    ],
    ['stretched to no length', (doc: Y.Doc, clip: Id, id: Id) => stretchNote(doc, by, clip, id, 0)],
    ['stretched to a length between two ticks', (doc: Y.Doc, clip: Id, id: Id) => stretchNote(doc, by, clip, id, 1.5)],
    [
      'stretched past the last tick',
      (doc: Y.Doc, clip: Id, id: Id) => stretchNote(doc, by, clip, id, lastTick + 2 - g5.tick)
    ]
  ])('%s is refused', (_, edit) => {
    const doc = newProject()
    const { clip } = parts(doc)
    addNote(doc, by, clip.id, g5)
    const [{ id }] = notesOf(doc)
    expect(updatesDuring(doc, () => expect(edit(doc, clip.id, id)).toBe(false))).toBe(0)
  })

  test('moved or stretched once it is gone, of a clip not there or erased, or on a track deleted, is refused', () => {
    const doc = newProject()
    const { track, clip } = parts(doc)
    addNote(doc, by, clip.id, g5)
    const [{ id }] = notesOf(doc)
    const refused = (clip: Id, note: Id) =>
      expect(
        updatesDuring(doc, () => {
          expect(moveNote(doc, by, clip, note, { ...g5, tick: Tick(0) })).toBe(false)
          expect(stretchNote(doc, by, clip, note, 240)).toBe(false)
        })
      ).toBe(0)
    refused(clip.id, Id('never'))
    refused(Id('nowhere'), id)
    rawMap(doc, 'tracks', track.id).set('deleted', true)
    refused(clip.id, id)
    rawMap(doc, 'tracks', track.id).set('deleted', false)
    rawMap(doc, 'clips', clip.id).set('deleted', true)
    refused(clip.id, id)
  })

  test('erased goes with the notes alike in tick and key, and with no other', () => {
    const doc = newProject()
    const { clip } = parts(doc)
    const notes = rawNotes(doc, clip.pattern)
    notes.set('erased', { tick: 480, len: 240, key: 67, vel: 1 })
    notes.set('alike', { tick: 480, len: 960, key: 67, vel: 0.5 })
    notes.set('higher', { tick: 480, len: 240, key: 68, vel: 1 })
    notes.set('later', { tick: 481, len: 240, key: 67, vel: 1 })
    expect(eraseNotes(doc, by, clip.id, [Id('erased')])).toBe(true)
    expect(notesOf(doc).map(({ id }) => id)).toEqual(['higher', 'later'])
  })

  test('erased once it is gone changes nothing; of a clip not there, it is refused', () => {
    const doc = newProject()
    const { clip } = parts(doc)
    addNote(doc, by, clip.id, g5)
    const [{ id }] = notesOf(doc)
    expect(eraseNotes(doc, by, clip.id, [id])).toBe(true)
    expect(updatesDuring(doc, () => expect(eraseNotes(doc, by, clip.id, [id, Id('never')])).toBe(true))).toBe(0)
    expect(eraseNotes(doc, by, Id('nowhere'), [id])).toBe(false)
  })

  test('put by two clients apart in one place is two notes; erased by one, it is gone for both', () => {
    const first = newProject()
    const second = new Y.Doc()
    sync(first, second)
    const { clip } = parts(first)
    expect(addNote(first, by, clip.id, g5)).toBe(true)
    expect(addNote(second, by, clip.id, g5)).toBe(true)
    sync(first, second)
    expect(notesOf(first)).toHaveLength(2)
    expect(eraseNotes(second, by, clip.id, [notesOf(second)[0].id])).toBe(true)
    sync(first, second)
    expect(notesOf(first)).toEqual([])
    expect(notesOf(second)).toEqual([])
  })
})

test("a pattern's notes are a map of the document's top: an edit of them is one transaction, and needs no mending", () => {
  const doc = newProject()
  const { clip } = parts(doc)
  const transactions = { count: 0 }
  const count = () => {
    transactions.count += 1
  }
  doc.on('afterTransaction', count)
  expect(addNote(doc, by, clip.id, { tick: Tick(480), key: MidiKey(60), length: 240 })).toBe(true)
  doc.off('afterTransaction', count)
  expect(transactions.count).toBe(1)
  expect(rawNotes(doc, clip.pattern).size).toBe(1)
  expect(replacementsOf(doc)).toEqual([])
})

test('notes two clients put apart into a clip new to both stay, each, as the map of them is one for both', () => {
  const first = newProject()
  const second = new Y.Doc()
  sync(first, second)
  const { track } = parts(first)
  const clip = Option.getOrThrow(addClip(first, by, { track: track.id, tick: Tick(barTicks) }))
  sync(first, second)
  const note = (tick: number) => ({ tick: Tick(tick), key: MidiKey(60), length: 240 })
  expect(addNote(first, by, clip, note(0))).toBe(true)
  expect(addNote(second, by, clip, note(480))).toBe(true)
  sync(first, second)
  const ticks = (doc: Y.Doc) =>
    Option.flatMap(Option.fromUndefinedOr(projectOf(doc).clips.find(({ id }) => id === clip)), ({ pattern }) =>
      Option.map(Option.fromUndefinedOr(projectOf(doc).patterns.find(({ id }) => id === pattern)), ({ notes }) =>
        notes.map(({ tick }) => tick).toSorted((a, b) => a - b)
      )
    )
  expect(ticks(first)).toEqual(Option.some([0, 480]))
  expect(ticks(second)).toEqual(ticks(first))
})

test('an edit into a map made anew is two transactions: the map, marked as no editor, then the edit, as its writer', () => {
  const doc = newProjectWithSynth()
  const synth = synthOf(doc)
  const origins: Array<unknown> = []
  const record = (transaction: Y.Transaction) => origins.push(transaction.origin)
  rawMap(doc, 'tracks', synth.id, 'instrument').delete('params')
  doc.on('afterTransaction', record)
  expect(setTrackParam(doc, by, synth.id, 'osc1.shape', 1)).toBe(true)
  expect(setTrackParam(doc, by, synth.id, 'osc1.shape', 2)).toBe(true)
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
  rawMap(doc, 'tracks', synth.id, 'instrument').set('params', 'broken')
  expect(() => doc.transact(() => setTrackParam(doc, by, synth.id, 'osc1.shape', 1), by)).toThrow(
    'Setup is written in a transaction of its own'
  )
  expect(rawMap(doc, 'tracks', synth.id, 'instrument').get('params')).toBe('broken')
})

describe("a track's parameter", () => {
  test('is set into its range, a choice as the nearest', () => {
    const doc = newProjectWithSynth()
    const synth = synthOf(doc)
    const set = (value: number) => {
      expect(setTrackParam(doc, by, synth.id, 'osc1.shape', value)).toBe(true)
      return shapeOf(doc)
    }
    expect(set(1)).toBe(1)
    expect(set(2.4)).toBe(2)
    expect(set(2.6)).toBe(3)
    expect(set(9)).toBe(4)
    expect(set(-1)).toBe(0)
  })

  test("is refused if it isn't a number, the instrument has no such parameter, or the track isn't there", () => {
    const doc = newProjectWithSynth()
    const { track } = parts(doc)
    const synth = synthOf(doc)
    const refused = () => {
      expect(setTrackParam(doc, by, synth.id, 'osc1.shape', Number.NaN)).toBe(false)
      expect(setTrackParam(doc, by, synth.id, 'osc1.shape', Number.POSITIVE_INFINITY)).toBe(false)
      expect(setTrackParam(doc, by, synth.id, 'cutoff', 200)).toBe(false)
      // A sampler has no volume of its own: its track's sets how loud.
      expect(setTrackParam(doc, by, track.id, 'volume', 0.5)).toBe(false)
      expect(setTrackParam(doc, by, Id('nobody'), 'osc1.shape', 1)).toBe(false)
    }
    expect(updatesDuring(doc, refused)).toBe(0)
    rawMap(doc, 'tracks', synth.id, 'instrument').set('plugin', { id: 99, version: 1 })
    expect(updatesDuring(doc, () => expect(setTrackParam(doc, by, synth.id, 'osc1.shape', 1)).toBe(false))).toBe(0)
  })

  test('of an instrument without parameters, or with something else in their place, is its first', () => {
    brokenWays.forEach((breakIt) => {
      const doc = newProjectWithSynth()
      const synth = synthOf(doc)
      breakIt(rawMap(doc, 'tracks', synth.id, 'instrument'), 'params')
      expect(setTrackParam(doc, by, synth.id, 'osc1.shape', 1)).toBe(true)
      expect(shapeOf(doc)).toBe(1)
      expect(replacementsOf(doc)).toEqual([])
    })
  })
})

describe("a track's strip", () => {
  const stripOf = (doc: Y.Doc) => projectOf(doc).tracks[0].strip
  const [volume, pan] = trackStrip

  test("is the engine's, but no louder than the sound as it is, and a new track's volume knob stands 5.2 dB down", () => {
    expect(trackStrip.map(({ id }) => id)).toEqual(strip.map(({ id }) => id))
    trackStrip.forEach((param, i) => {
      expect(param.min).toBeGreaterThanOrEqual(strip[i].min)
      expect(param.max).toBeLessThanOrEqual(strip[i].max)
    })
    expect(formatValue(volume, volume.max)).toBe('0.0 dB')
    expect(pan).toMatchObject({ min: -1, max: 1 })
    expect(paramPosition(volume, volume.default)).toBeCloseTo(newTrackPosition, 9)
    expect(formatValue(volume, volume.default)).toBe('−5.2 dB')
    expect(pan.default).toBe(0)
  })

  test('starts at its defaults, and each parameter is set into its range on its own', () => {
    const doc = newProject()
    const { track } = parts(doc)
    expect(stripOf(doc)).toEqual(defaultTrackStrip)
    expect(setTrackStrip(doc, by, track.id, 'pan', -0.5)).toBe(true)
    expect(stripOf(doc)).toEqual({ ...defaultTrackStrip, pan: -0.5 })
    expect(setTrackStrip(doc, by, track.id, 'volume', 9)).toBe(true)
    expect(stripOf(doc)).toEqual({ volume: volume.max, pan: -0.5 })
    expect(setTrackStrip(doc, by, track.id, 'pan', -9)).toBe(true)
    expect(setTrackStrip(doc, by, track.id, 'volume', -1)).toBe(true)
    expect(stripOf(doc)).toEqual({ volume: volume.min, pan: pan.min })
    expect(replacementsOf(doc)).toEqual([])
  })

  test("is refused if it isn't a number or the track isn't there", () => {
    const doc = newProject()
    const { track } = parts(doc)
    const refused = () => {
      expect(setTrackStrip(doc, by, track.id, 'volume', Number.NaN)).toBe(false)
      expect(setTrackStrip(doc, by, track.id, 'pan', Number.NEGATIVE_INFINITY)).toBe(false)
      expect(setTrackStrip(doc, by, Id('nobody'), 'pan', 0.5)).toBe(false)
    }
    expect(updatesDuring(doc, refused)).toBe(0)
  })

  test('two clients turning its two knobs at once keep both', () => {
    const [first, second] = [newProject(), new Y.Doc()]
    sync(first, second)
    const { track } = parts(first)
    expect(setTrackStrip(first, by, track.id, 'volume', 0.5)).toBe(true)
    expect(setTrackStrip(second, by, track.id, 'pan', 0.25)).toBe(true)
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

  test('a track goes into an insert, and back into the master; an insert there is not, or a track, is refused', () => {
    const doc = newProject()
    const { track } = parts(doc)
    const insert = () => projectOf(doc).tracks[0].insert
    expect(setTrackInsert(doc, by, track.id, Id('3'))).toBe(true)
    expect(insert()).toBe('3')
    expect(setTrackInsert(doc, by, track.id, Id('master'))).toBe(true)
    expect(insert()).toBe('master')
    const refused = () => {
      ;['0', '501', 'nowhere'].forEach((id) => expect(setTrackInsert(doc, by, track.id, Id(id))).toBe(false))
      expect(setTrackInsert(doc, by, Id('nobody'), Id('3'))).toBe(false)
    }
    expect(updatesDuring(doc, refused)).toBe(0)
    expect(replacementsOf(doc)).toEqual([])
  })

  test('the master goes nowhere new for a track the document holds no insert of', () => {
    const doc = newProject()
    const { track } = parts(doc)
    expect(updatesDuring(doc, () => expect(setTrackInsert(doc, by, track.id, Id('master'))).toBe(true))).toBe(0)
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
    expect(createProject(empty, by)).toBe(true)
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

test('a track is muted and unmuted; one not there is refused', () => {
  const doc = newProject()
  const { track } = parts(doc)
  expect(setMute(doc, by, track.id, true)).toBe(true)
  expect(projectOf(doc).tracks[0].mute).toBe(true)
  expect(setMute(doc, by, track.id, false)).toBe(true)
  expect(projectOf(doc).tracks[0].mute).toBe(false)
  expect(updatesDuring(doc, () => expect(setMute(doc, by, Id('nobody'), true)).toBe(false))).toBe(0)
})

test('a value the document already holds is not written again', () => {
  const doc = newProjectWithSynth()
  const { track, slot } = parts(doc)
  const synth = synthOf(doc)
  expect(setTrackParam(doc, by, synth.id, 'osc1.shape', 9)).toBe(true)
  expect(setTrackStrip(doc, by, track.id, 'pan', 2)).toBe(true)
  expect(setMasterParam(doc, by, slot.id, 'cutoff', 1200)).toBe(true)
  expect(setTempo(doc, by, 1000)).toBe(true)
  const again = () => {
    expect(setTrackParam(doc, by, synth.id, 'osc1.shape', 4)).toBe(true)
    expect(setTrackParam(doc, by, synth.id, 'osc1.shape', 4.4)).toBe(true)
    expect(setTrackStrip(doc, by, track.id, 'pan', 1)).toBe(true)
    expect(setTrackStrip(doc, by, track.id, 'pan', 3)).toBe(true)
    expect(setMasterParam(doc, by, slot.id, 'cutoff', 1200)).toBe(true)
    expect(setTempo(doc, by, maxTempo)).toBe(true)
    expect(setTempo(doc, by, 2000)).toBe(true)
    expect(setMute(doc, by, track.id, false)).toBe(true)
    expect(renameTrack(doc, by, track.id, ' Kick ')).toBe(true)
  }
  expect(updatesDuring(doc, again)).toBe(0)
})

test('nor is the value a document reads where it holds none: an edit that changes nothing is no step of undo', () => {
  const doc = newProjectWithSynth()
  const { track } = parts(doc)
  const synth = synthOf(doc)
  ;['mute', 'volume', 'pan'].forEach((key) => rawMap(doc, 'tracks', track.id).delete(key))
  rawMap(doc, 'meta').delete('bpm')
  const none = () => {
    expect(setTrackParam(doc, by, synth.id, 'osc1.shape', plugins.synth.params[0].default)).toBe(true)
    expect(setTrackStrip(doc, by, track.id, 'volume', defaultTrackStrip.volume)).toBe(true)
    expect(setTrackStrip(doc, by, track.id, 'pan', 0)).toBe(true)
    expect(setMute(doc, by, track.id, false)).toBe(true)
    expect(setTempo(doc, by, defaultTempo)).toBe(true)
  }
  expect(updatesDuring(doc, none)).toBe(0)
  expect(setTrackParam(doc, by, synth.id, 'osc1.shape', 0)).toBe(true)
  expect(shapeOf(doc)).toBe(0)
})

test('a broken value is written over even when it reads as the one written', () => {
  const doc = newProject()
  const { track } = parts(doc)
  rawMap(doc, 'tracks', track.id).set('mute', 'no')
  expect(projectOf(doc).tracks[0].mute).toBe(false)
  expect(updatesDuring(doc, () => expect(setMute(doc, by, track.id, false)).toBe(true))).toBe(1)
  expect(replacementsOf(doc)).toEqual([])
})

test('no tempo is set on a document without a project, which can then still have one', () => {
  const doc = new Y.Doc()
  expect(updatesDuring(doc, () => expect(setTempo(doc, by, 140)).toBe(false))).toBe(0)
  expect(createProject(doc, by)).toBe(true)
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
  const { track, clip: first, slot } = parts(doc)
  const synth = synthOf(doc)
  const clip = Option.getOrThrow(addClip(doc, by, { track: track.id, tick: Tick(barTicks) }))
  // Two notes in one place, as two clients make them: erasing one erases both at once.
  ;['first', 'second'].forEach((id) => rawNotes(doc, first.pattern).set(id, { tick: 960 }))
  const operations = [
    () => addNote(doc, by, first.id, { tick: Tick(0), key: MidiKey(64), length: 480 }),
    () => moveNote(doc, by, first.id, Id('first'), { tick: Tick(480), key: MidiKey(60) }),
    () => stretchNote(doc, by, first.id, Id('first'), 960),
    () => eraseNotes(doc, by, first.id, [Id('second'), Id('first')]),
    () => setTrackParam(doc, by, synth.id, 'osc1.shape', 1),
    () => setTrackStrip(doc, by, track.id, 'pan', 2),
    () => setMasterParam(doc, by, slot.id, 'cutoff', 0),
    () => setMute(doc, by, track.id, true),
    () => setTempo(doc, by, 600),
    () => renameTrack(doc, by, track.id, 'Tom'),
    () => deleteTrack(doc, by, synth.id),
    () => moveClip(doc, by, clip, { track: projectOf(doc).tracks[1].id, tick: Tick(2 * barTicks) }),
    () => resizeClip(doc, by, clip, 2 * barTicks),
    () => trimClip(doc, by, clip, { tick: Tick(3 * barTicks), length: barTicks, offset: barTicks }),
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

describe('a track added', () => {
  const names = (doc: Y.Doc) => projectOf(doc).tracks.map(({ name }) => name)

  test('comes after the others with a synth at its defaults, named after it with a name no other track has', () => {
    const doc = newProject()
    const added = Option.getOrThrow(addTrack(doc, by))
    expect(Option.isSome(addTrack(doc, by))).toBe(true)
    expect(names(doc)).toEqual([...drums.map(({ name }) => name), 'Synth', 'Synth 2'])
    const track = projectOf(doc).tracks.find(({ id }) => id === added)
    expect(track?.mute).toBe(false)
    const instrument = Option.flatMap(Option.fromUndefinedOr(track), ({ instrument }) => instrument)
    expect(Option.map(instrument, ({ name, params }) => ({ name, params }))).toEqual(
      Option.some({ name: 'synth', params: synthDefaults })
    )
    // A name taken otherwise, and one a deleted track had, which is free again.
    const [kick, snare] = projectOf(doc).tracks
    rawMap(doc, 'tracks', kick.id).set('name', 'Synth 3')
    rawMap(doc, 'tracks', snare.id).set('deleted', true)
    rawMap(doc, 'tracks', snare.id).set('name', 'Synth 4')
    expect(Option.isSome(addTrack(doc, by))).toBe(true)
    expect(names(doc).at(-1)).toBe('Synth 4')
  })

  test('plays the instrument given, with the sounds of its samples, named after it', () => {
    const doc = emptyProject()
    const [kick] = drums
    const added = Option.getOrThrow(addTrack(doc, by, { plugin: plugins.sampler, sounds: { sample: kick.sound } }))
    expect(projectOf(doc).tracks.map(({ id, name }) => ({ id, name }))).toEqual([{ id: added, name: 'Sampler' }])
    const instrument = Option.flatMap(Option.fromUndefinedOr(projectOf(doc).tracks[0]), ({ instrument }) => instrument)
    expect(Option.map(instrument, ({ name, samples }) => ({ name, samples }))).toEqual(
      Option.some({ name: 'sampler', samples: { sample: kick.sound } })
    )
    expect(replacementsOf(doc)).toEqual([])
  })

  test("comes after the others even if some of their places can't be read, and first if none can", () => {
    const doc = newProject()
    const [kick] = projectOf(doc).tracks
    // Past every index, as `~` sorts after the digits and letters they are made of.
    rawMap(doc, 'tracks', kick.id).set('order', '~broken')
    expect(Option.isSome(addTrack(doc, by))).toBe(true)
    expect(names(doc).slice(-2)).toEqual(['Synth', 'Kick'])
    const unreadable = newProject()
    projectOf(unreadable).tracks.forEach(({ id }) => {
      rawMap(unreadable, 'tracks', id).set('order', '')
    })
    expect(Option.isSome(addTrack(unreadable, by))).toBe(true)
    expect(names(unreadable).at(-1)).toBe('Synth')
  })

  test('is refused in a document without a project', () => {
    const doc = new Y.Doc()
    expect(updatesDuring(doc, () => expect(addTrack(doc, by)).toEqual(Option.none()))).toBe(0)
  })
})

describe('a track renamed', () => {
  test('takes the name without the spaces around it, one another track has too', () => {
    const doc = newProject()
    const [kick, snare] = projectOf(doc).tracks
    expect(renameTrack(doc, by, kick.id, '  Big kick\t')).toBe(true)
    expect(renameTrack(doc, by, snare.id, 'Big kick')).toBe(true)
    expect(
      projectOf(doc)
        .tracks.map(({ name }) => name)
        .slice(0, 2)
    ).toEqual(['Big kick', 'Big kick'])
  })

  test("keeps its name for one that is empty or only spaces, and is refused if it isn't there or is deleted", () => {
    const doc = newProject()
    const [kick, snare] = projectOf(doc).tracks
    rawMap(doc, 'tracks', snare.id).set('deleted', true)
    const refused = () => {
      expect(renameTrack(doc, by, kick.id, '')).toBe(false)
      expect(renameTrack(doc, by, kick.id, ' \n ')).toBe(false)
      expect(renameTrack(doc, by, snare.id, 'Tom')).toBe(false)
      expect(renameTrack(doc, by, Id('nobody'), 'Tom')).toBe(false)
    }
    expect(updatesDuring(doc, refused)).toBe(0)
    expect(projectOf(doc).tracks[0].name).toBe('Kick')
  })

  test('writes over a name that is something else, which reads as none', () => {
    const doc = newProject()
    const { track } = parts(doc)
    rawMap(doc, 'tracks', track.id).set('name', 7)
    expect(renameTrack(doc, by, track.id, 'Kick')).toBe(true)
    expect(projectOf(doc).tracks[0].name).toBe('Kick')
    expect(replacementsOf(doc)).toEqual([])
  })
})

describe('a track deleted', () => {
  test('is marked so: its place, strip, instrument and clips stay in the document, its clips hidden with it', () => {
    const doc = newProject()
    const { track, clip } = parts(doc)
    expect(addNote(doc, by, clip.id, { tick: Tick(0), key: MidiKey(60), length: 240 })).toBe(true)
    expect(setTrackStrip(doc, by, track.id, 'pan', 2)).toBe(true)
    const before = rawMap(doc, 'tracks', track.id).toJSON()
    expect(deleteTrack(doc, by, track.id)).toBe(true)
    expect(projectOf(doc).tracks.map(({ name }) => name)).toEqual(drums.slice(1).map(({ name }) => name))
    expect(rawMap(doc, 'tracks', track.id).toJSON()).toEqual({ ...before, deleted: true })
    expect(projectOf(doc).clips).toEqual([])
    expect(projectOf(doc).patterns).toEqual([])
    expect(rawNotes(doc, clip.pattern).size).toBe(1)
    // As an undo of the deletion writes it.
    rawMap(doc, 'tracks', track.id).set('deleted', false)
    expect(projectOf(doc).clips.map(({ id }) => id)).toEqual([clip.id])
    expect(notesOf(doc)).toHaveLength(1)
  })

  test('again, or not there, is refused', () => {
    const doc = newProject()
    const { track } = parts(doc)
    expect(deleteTrack(doc, by, track.id)).toBe(true)
    const refused = () => {
      expect(deleteTrack(doc, by, track.id)).toBe(false)
      expect(deleteTrack(doc, by, Id('nobody'))).toBe(false)
    }
    expect(updatesDuring(doc, refused)).toBe(0)
  })

  test('keeps its place: one added after it goes after it, and it comes back before that one', () => {
    const doc = newProject()
    const [, , , clap] = projectOf(doc).tracks
    const ids = () => projectOf(doc).tracks.map(({ id }) => id)
    expect(deleteTrack(doc, by, clap.id)).toBe(true)
    const synth = Option.getOrThrow(addTrack(doc, by))
    rawMap(doc, 'tracks', clap.id).set('deleted', false)
    expect(ids().slice(-2)).toEqual([clap.id, synth])
    const places = ids().map((id) => rawMap(doc, 'tracks', id).get('order'))
    expect(new Set(places).size).toBe(places.length)
  })

  test('to the last leaves a project with no tracks, which can have one again', () => {
    const doc = newProject()
    projectOf(doc).tracks.forEach(({ id }) => {
      expect(deleteTrack(doc, by, id)).toBe(true)
    })
    expect(projectOf(doc).tracks).toEqual([])
    expect(Option.isSome(addTrack(doc, by))).toBe(true)
    expect(projectOf(doc).tracks.map(({ name }) => name)).toEqual(['Synth'])
  })
})

describe('a project created', () => {
  test("holds only the master, with nothing on it, at the engine's tempo", () => {
    const doc = new Y.Doc()
    const id = Id('made')
    expect(createProject(doc, by, id)).toBe(true)
    expect(projectOf(doc)).toEqual({
      tempo: defaultTempo,
      tracks: [],
      clips: [],
      patterns: [],
      master: { strip: defaultStrip, slots: [] },
      inserts: []
    })
    expect(doc.getMap('meta').toJSON()).toEqual({ id, bpm: defaultTempo })
    expect(replacementsOf(doc)).toEqual([])
  })

  test('is refused in a document that holds one', () => {
    const doc = emptyProject()
    expect(updatesDuring(doc, () => expect(createProject(doc, by)).toBe(false))).toBe(0)
  })
})

describe('a clip', () => {
  const clipsOf = (doc: Y.Doc) => projectOf(doc).clips
  const place = (track: Id, bar: number) => ({ track, tick: Tick(bar * barTicks) })
  /** A project with one track, and no clip on it. */
  const withTracks = () => {
    const doc = emptyProject()
    const tracks = drums.map((drum) => addDrum(doc, drum))
    return { doc, tracks }
  }

  test('added has a pattern of its own, at the place, set up deleted and then brought in by its writer', () => {
    const { doc, tracks } = withTracks()
    const written: Array<{ readonly origin: unknown; readonly deleted: unknown }> = []
    const record = ({ origin }: Y.Transaction) =>
      written.push({ origin, deleted: Object.values(doc.getMap('clips').toJSON())[0]?.deleted })
    doc.on('afterTransaction', record)
    const added = Option.getOrThrow(addClip(doc, by, place(tracks[2], 2)))
    doc.off('afterTransaction', record)
    expect(written.map(({ origin, deleted }) => ({ by: origin === by, deleted }))).toEqual([
      { by: false, deleted: true },
      { by: true, deleted: false }
    ])
    const [clip] = clipsOf(doc)
    expect(clip).toEqual({
      id: added,
      track: tracks[2],
      tick: 2 * barTicks,
      pattern: expect.any(String),
      ownLength: Option.none(),
      offset: 0
    })
    expect(rawMap(doc, 'clips', added).toJSON()).toEqual({
      track: tracks[2],
      bounds: { tick: 2 * barTicks },
      pattern: clip.pattern,
      deleted: false
    })
    expect(projectOf(doc).patterns).toEqual([{ id: clip.pattern, notes: [] }])
    const second = Option.getOrThrow(addClip(doc, by, place(tracks[2], 3)))
    expect(clipsOf(doc).find(({ id }) => id === second)?.pattern).not.toBe(clip.pattern)
    expect(replacementsOf(doc)).toEqual([])
  })

  test("is refused for a track deleted or not there, or a tick not whole or out of the engine's range", () => {
    const { doc, tracks } = withTracks()
    expect(deleteTrack(doc, by, tracks[3])).toBe(true)
    const refused = () => {
      ;[tracks[3], Id('nobody')].forEach((gone) => expect(addClip(doc, by, place(gone, 0))).toEqual(Option.none()))
      // Past the brand, as a client without types could send them.
      ;[-barTicks, 0.5, lastTick + 1, Number.NaN].forEach((tick) =>
        expect(addClip(doc, by, { track: tracks[0], tick: tick as Tick })).toEqual(Option.none())
      )
    }
    expect(updatesDuring(doc, refused)).toBe(0)
    expect(clipsOf(doc)).toEqual([])
  })

  test('moved writes only what changes: its track, its start, or both', () => {
    const { doc, tracks } = withTracks()
    const clip = Option.getOrThrow(addClip(doc, by, place(tracks[0], 0)))
    const { pattern } = clipsOf(doc)[0]
    const raw = () => rawMap(doc, 'clips', clip).toJSON()
    expect(updatesDuring(doc, () => expect(moveClip(doc, by, clip, place(tracks[0], 0))).toBe(true))).toBe(0)
    expect(moveClip(doc, by, clip, place(tracks[3], 0))).toBe(true)
    expect(raw()).toMatchObject({ track: tracks[3], bounds: { tick: 0 } })
    expect(moveClip(doc, by, clip, place(tracks[3], 3))).toBe(true)
    expect(moveClip(doc, by, clip, place(tracks[1], 1))).toBe(true)
    expect(clipsOf(doc)).toEqual([
      { id: clip, track: tracks[1], tick: barTicks, pattern, ownLength: Option.none(), offset: 0 }
    ])
    expect(replacementsOf(doc)).toEqual([])
    // A broken start is written over, though it reads as the one written.
    rawMap(doc, 'clips', clip).set('bounds', { tick: barTicks - 0.4 })
    expect(updatesDuring(doc, () => expect(moveClip(doc, by, clip, place(tracks[1], 1))).toBe(true))).toBe(1)
    expect(raw()).toMatchObject({ bounds: { tick: barTicks } })
    expect(replacementsOf(doc)).toEqual([])
  })

  test('moved is refused for one erased, not there or on a deleted track, to a track not live or a tick not in time, or where a length of its own ends too late', () => {
    const { doc, tracks } = withTracks()
    const clip = Option.getOrThrow(addClip(doc, by, place(tracks[0], 0)))
    const long = Option.getOrThrow(addClip(doc, by, place(tracks[1], 0)))
    expect(resizeClip(doc, by, long, 3 * barTicks)).toBe(true)
    const lastBar = Math.floor(lastTick / barTicks)
    const erased = Option.getOrThrow(addClip(doc, by, place(tracks[1], 4)))
    expect(eraseClips(doc, by, [erased])).toBe(true)
    const hidden = Option.getOrThrow(addClip(doc, by, place(tracks[2], 0)))
    expect(deleteTrack(doc, by, tracks[2])).toBe(true)
    const refused = () => {
      expect(moveClip(doc, by, hidden, place(tracks[3], 0))).toBe(false)
      expect(moveClip(doc, by, erased, place(tracks[3], 0))).toBe(false)
      expect(moveClip(doc, by, Id('nobody'), place(tracks[3], 0))).toBe(false)
      expect(moveClip(doc, by, clip, place(tracks[2], 0))).toBe(false)
      expect(moveClip(doc, by, clip, place(Id('nobody'), 0))).toBe(false)
      expect(moveClip(doc, by, clip, { track: tracks[0], tick: -barTicks as Tick })).toBe(false)
      expect(moveClip(doc, by, long, place(tracks[1], lastBar - 1))).toBe(false)
    }
    expect(updatesDuring(doc, refused)).toBe(0)
    // One as long as its pattern goes there, its end past the latest one, as the pattern may grow and shrink.
    expect(moveClip(doc, by, clip, place(tracks[0], lastBar - 1))).toBe(true)
  })

  test('made longer or shorter takes a length of its own, kept as it moves; the length it has writes nothing', () => {
    const { doc, tracks } = withTracks()
    const clip = Option.getOrThrow(addClip(doc, by, place(tracks[0], 0)))
    const raw = () => rawMap(doc, 'clips', clip).toJSON()
    const ownLengths = () => clipsOf(doc).map(({ ownLength }) => ownLength)
    expect(resizeClip(doc, by, clip, 3 * barTicks)).toBe(true)
    expect(raw()).toMatchObject({ bounds: { tick: 0, length: 3 * barTicks } })
    expect(updatesDuring(doc, () => expect(resizeClip(doc, by, clip, 3 * barTicks)).toBe(true))).toBe(0)
    expect(moveClip(doc, by, clip, place(tracks[1], 4))).toBe(true)
    expect(raw()).toMatchObject({ track: tracks[1], bounds: { tick: 4 * barTicks, length: 3 * barTicks } })
    // As long as its pattern now, though: a length of its own all the same, kept as the pattern grows.
    expect(resizeClip(doc, by, clip, barTicks)).toBe(true)
    expect(ownLengths()).toEqual([Option.some(barTicks)])
    expect(replacementsOf(doc)).toEqual([])
  })

  test('trimmed at its start takes its start, its length and its offset together, kept as it moves and resizes', () => {
    const { doc, tracks } = withTracks()
    const clip = Option.getOrThrow(addClip(doc, by, place(tracks[0], 2)))
    const raw = () => rawMap(doc, 'clips', clip).toJSON()
    const span = { tick: Tick(3 * barTicks), length: 2 * barTicks, offset: barTicks / 2 }
    expect(trimClip(doc, by, clip, span)).toBe(true)
    expect(raw()).toMatchObject({ bounds: { tick: 3 * barTicks, length: 2 * barTicks, offset: barTicks / 2 } })
    expect(updatesDuring(doc, () => expect(trimClip(doc, by, clip, span)).toBe(true))).toBe(0)
    expect(moveClip(doc, by, clip, place(tracks[1], 0))).toBe(true)
    expect(resizeClip(doc, by, clip, barTicks)).toBe(true)
    expect(raw()).toMatchObject({ bounds: { tick: 0, length: barTicks, offset: barTicks / 2 } })
    // From a round's start, the document holds no offset.
    expect(trimClip(doc, by, clip, { ...span, offset: 0 })).toBe(true)
    expect(raw()).toMatchObject({ bounds: { tick: 3 * barTicks, length: 2 * barTicks } })
    expect(Object.keys(raw().bounds)).toEqual(['tick', 'length'])
    expect(replacementsOf(doc)).toEqual([])
  })

  test('trimmed is refused for a start, length or offset out of range or not whole, or one not live', () => {
    const { doc, tracks } = withTracks()
    const clip = Option.getOrThrow(addClip(doc, by, place(tracks[0], 2)))
    const erased = Option.getOrThrow(addClip(doc, by, place(tracks[1], 0)))
    expect(eraseClips(doc, by, [erased])).toBe(true)
    const hidden = Option.getOrThrow(addClip(doc, by, place(tracks[2], 0)))
    expect(deleteTrack(doc, by, tracks[2])).toBe(true)
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
      ;[hidden, erased, Id('nobody')].forEach((gone) => expect(trimClip(doc, by, gone, span)).toBe(false))
    }
    expect(updatesDuring(doc, refused)).toBe(0)
  })

  test('resized is refused for a length not whole, under a tick or ending too late, or one not live', () => {
    const { doc, tracks } = withTracks()
    const clip = Option.getOrThrow(addClip(doc, by, place(tracks[0], 2)))
    const erased = Option.getOrThrow(addClip(doc, by, place(tracks[1], 0)))
    expect(eraseClips(doc, by, [erased])).toBe(true)
    const hidden = Option.getOrThrow(addClip(doc, by, place(tracks[2], 0)))
    expect(deleteTrack(doc, by, tracks[2])).toBe(true)
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
    const { doc, tracks } = withTracks()
    const [first, second] = [0, 1].map((bar) => Option.getOrThrow(addClip(doc, by, place(tracks[0], bar))))
    const hidden = Option.getOrThrow(addClip(doc, by, place(tracks[1], 0)))
    expect(deleteTrack(doc, by, tracks[1])).toBe(true)
    const before = rawMap(doc, 'clips', first).toJSON()
    expect(eraseClips(doc, by, [first, Id('nobody')])).toBe(true)
    expect(rawMap(doc, 'clips', first).toJSON()).toEqual({ ...before, deleted: true })
    expect(clipsOf(doc).map(({ id }) => id)).toEqual([second])
    expect(updatesDuring(doc, () => expect(eraseClips(doc, by, [first, hidden])).toBe(true))).toBe(0)
    expect(updatesDuring(new Y.Doc(), () => expect(eraseClips(new Y.Doc(), by, [second])).toBe(false))).toBe(0)
  })

  test('on a deleted track is left out, and back with it', () => {
    const { doc, tracks } = withTracks()
    const clip = Option.getOrThrow(addClip(doc, by, place(tracks[1], 0)))
    expect(deleteTrack(doc, by, tracks[1])).toBe(true)
    expect(clipsOf(doc)).toEqual([])
    rawMap(doc, 'tracks', tracks[1]).set('deleted', false)
    expect(clipsOf(doc).map(({ id }) => id)).toEqual([clip])
  })
})
