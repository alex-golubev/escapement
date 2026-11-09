import { lastTick, MidiKey, Tick } from '@escapement/engine-description'
import { Effect, Option, Order } from 'effect'
import { Atom, AtomRegistry } from 'effect/reactivity'
import { describe, expect, test } from 'vitest'
import * as Y from 'yjs'
import {
  addClip,
  addNote,
  barTicks,
  batchedState,
  byContent,
  deleteTrack,
  eraseClips,
  eraseNotes,
  followProject,
  Id,
  moveClip,
  type ProjectAtoms,
  patternEnd,
  setMasterStrip,
  setMasterParam,
  setTempo,
  setTrackStrip
} from '../src'
import { by, newProject, newProjectWithSynth, parts, projectOf, rawMap, rawNotes, sync, synthOf, told } from './project'

/**
 * Follows the document while `use` runs, then stops. Every part is mounted first, as the compiler and the page keep what
 * they read: one that isn't reads the document anew each time, followed or not.
 */
const following = <A>(doc: Y.Doc, use: (atoms: ProjectAtoms, registry: AtomRegistry.AtomRegistry) => A): A => {
  const registry = AtomRegistry.make()
  return Effect.runSync(
    followProject(doc).pipe(
      Effect.map((atoms) => {
        const parts: ReadonlyArray<Atom.Atom<unknown>> = [atoms.tempo, atoms.trackIds, atoms.clips, atoms.master]
        const { tracks, clips } = projectOf(doc)
        const ofTracks = tracks.map(({ id }) => atoms.track(id))
        const ofClips = clips.flatMap(({ id, pattern }) => [
          atoms.clip(id),
          atoms.notes(pattern),
          atoms.patternEnd(pattern)
        ])
        ;[...parts, ...ofTracks, ...ofClips].forEach((atom) => registry.mount(atom))
        return use(atoms, registry)
      }),
      Effect.scoped,
      Effect.provideService(AtomRegistry.AtomRegistry, registry)
    )
  )
}

const ids = (doc: Y.Doc) => {
  const { tracks, clips } = projectOf(doc)
  return { tracks: tracks.map(({ id }) => id), clip: clips[0] }
}

const note = (tick: number) => ({ tick: Tick(tick), key: MidiKey(60), length: 240 })

describe('the atoms of a project', () => {
  test('read each part as reading the whole project does', () => {
    const doc = newProjectWithSynth()
    rawMap(doc, 'tracks', synthOf(doc).id, 'instrument', 'params').set('osc1.shape', 'saw')
    rawNotes(doc, parts(doc).clip.pattern).set('n', { tick: 0 })
    const project = projectOf(doc)
    following(doc, (atoms, registry) => {
      expect(registry.get(atoms.tempo)).toBe(project.tempo)
      expect(registry.get(atoms.trackIds)).toEqual(project.tracks.map(({ id }) => id))
      project.tracks.forEach((track) => expect(registry.get(atoms.track(track.id))).toEqual(Option.some(track)))
      expect(registry.get(atoms.clips)).toEqual(project.clips)
      project.clips.forEach((clip) => expect(registry.get(atoms.clip(clip.id))).toEqual(Option.some(clip)))
      project.patterns.forEach((pattern) => expect(registry.get(atoms.notes(pattern.id))).toEqual(pattern.notes))
      expect(registry.get(atoms.master)).toEqual(project.master)
    })
  })

  test('follow every operation, and tell what depends on two parts once a transaction', () => {
    const doc = newProject()
    const { tracks, clip } = ids(doc)
    following(doc, (atoms, registry) => {
      const volumes = byContent((get) =>
        tracks.map((id) => Option.map(get(atoms.track(id)), (track) => track.strip.volume))
      )
      const values = told(registry, volumes)
      doc.transact(() => {
        setTrackStrip(doc, by, tracks[0], 'volume', 0.1)
        setTrackStrip(doc, by, tracks[1], 'volume', 0.2)
      })
      expect(values).toHaveLength(2)
      expect(values[1]).toEqual([Option.some(0.1), Option.some(0.2), ...values[0].slice(2)])
      setTempo(doc, by, 90)
      expect(registry.get(atoms.tempo)).toBe(90)
      addNote(doc, by, clip.id, note(720))
      expect(registry.get(atoms.notes(clip.pattern)).map(({ tick }) => tick)).toEqual([720])
    })
  })

  test('tell nothing to what a change leaves as it was', () => {
    const doc = newProject()
    const { tracks, clip } = ids(doc)
    following(doc, (atoms, registry) => {
      const notes = told(registry, atoms.notes(clip.pattern))
      const clips = told(registry, atoms.clips)
      const order = told(registry, atoms.trackIds)
      setTrackStrip(doc, by, tracks[0], 'volume', 0.1)
      // Written again as it is.
      doc.transact(() => rawMap(doc, 'meta').set('bpm', 120))
      expect(notes).toHaveLength(1)
      expect(order).toHaveLength(1)
      addNote(doc, by, clip.id, note(0))
      expect(notes).toHaveLength(2)
      expect(clips).toHaveLength(1)
      expect(order).toHaveLength(1)
    })
  })

  test('follow tracks deleted, removed, added and moved', () => {
    const doc = newProject()
    const { tracks } = ids(doc)
    following(doc, (atoms, registry) => {
      doc.transact(() => rawMap(doc, 'tracks', tracks[0]).set('deleted', true))
      expect(registry.get(atoms.trackIds)).toEqual(tracks.slice(1))
      expect(registry.get(atoms.track(tracks[0]))).toEqual(Option.none())
      doc.transact(() => doc.getMap('tracks').delete(tracks[1]))
      expect(registry.get(atoms.trackIds)).toEqual(tracks.slice(2))
      doc.transact(() => rawMap(doc, 'tracks', tracks[3]).set('order', ' '))
      expect(registry.get(atoms.trackIds)).toEqual([tracks[3], tracks[2]])
      const added = Id('added')
      doc.transact(() => doc.getMap('tracks').set(added, new Y.Map(Object.entries({ order: '~', deleted: false }))))
      expect(registry.get(atoms.trackIds)).toEqual([tracks[3], tracks[2], added])
      expect(Option.map(registry.get(atoms.track(added)), ({ instrument }) => instrument)).toEqual(
        Option.some(Option.none())
      )
    })
  })

  test('read a track again when a new one takes its ID, and the master as it changes', () => {
    const doc = newProject()
    const { tracks } = ids(doc)
    const { slot } = parts(doc)
    following(doc, (atoms, registry) => {
      const names = told(registry, atoms.track(tracks[0]))
      const masters = told(registry, atoms.master)
      doc.transact(() =>
        doc.getMap('tracks').set(tracks[0], new Y.Map(Object.entries({ name: 'Tom', order: 'a0', deleted: false })))
      )
      expect(names.map((track) => Option.map(track, ({ name }) => name))).toEqual([
        Option.some('Kick'),
        Option.some('Tom')
      ])
      setMasterParam(doc, by, slot.id, 'cutoff', 500)
      expect(masters.map(({ slots }) => slots.map((s) => s.name === 'filter' && s.params.cutoff))).toEqual([
        [20000],
        [500]
      ])
    })
  })

  test('follow clips put, moved and erased, and leave out those on a track deleted, until it is back', () => {
    const doc = newProject()
    const { tracks, clip: first } = ids(doc)
    const at = (track: Id, bar: number) => ({ track, tick: Tick(bar * barTicks) })
    following(doc, (atoms, registry) => {
      const clips = () => registry.get(atoms.clips).map(({ id, track, tick }) => ({ id, track, tick }))
      const clip = Option.getOrThrow(addClip(doc, by, at(tracks[1], 0)))
      const shown = told(registry, atoms.clip(clip))
      expect(clips()).toEqual(
        [
          { id: first.id, track: tracks[0], tick: 0 },
          { id: clip, track: tracks[1], tick: 0 }
        ].toSorted(Order.mapInput(Order.String, ({ id }: { readonly id: Id }) => id))
      )
      moveClip(doc, by, clip, at(tracks[2], 3))
      deleteTrack(doc, by, tracks[2])
      expect(clips()).toEqual([{ id: first.id, track: tracks[0], tick: 0 }])
      doc.transact(() => rawMap(doc, 'tracks', tracks[2]).set('deleted', false))
      eraseClips(doc, by, [first.id])
      expect(clips()).toEqual([{ id: clip, track: tracks[2], tick: 3 * barTicks }])
      expect(shown.map((one) => Option.map(one, ({ track, tick }) => ({ track, tick })))).toEqual([
        Option.some({ track: tracks[1], tick: 0 }),
        Option.some({ track: tracks[2], tick: 3 * barTicks }),
        Option.none(),
        Option.some({ track: tracks[2], tick: 3 * barTicks })
      ])
    })
  })

  test('follow the notes of a clip whose map comes from another client before it is read here', () => {
    const doc = newProject()
    const other = new Y.Doc()
    sync(doc, other)
    const { tracks } = ids(doc)
    following(doc, (atoms, registry) => {
      const added = Option.getOrThrow(addClip(other, by, { track: tracks[0], tick: Tick(barTicks) }))
      addNote(other, by, added, note(240))
      sync(doc, other)
      const { pattern } = Option.getOrThrow(registry.get(atoms.clip(added)))
      const notes = told(registry, atoms.notes(pattern))
      addNote(other, by, added, note(720))
      sync(doc, other)
      const ticks = (one: (typeof notes)[number]) => one.map(({ tick }) => tick).toSorted((a, b) => a - b)
      expect(notes.map(ticks)).toEqual([[240], [240, 720]])
    })
  })

  test("follow the master as its strip changes, another client's edit too", () => {
    const doc = newProject()
    const other = new Y.Doc()
    sync(doc, other)
    following(doc, (atoms, registry) => {
      const masters = told(registry, atoms.master)
      setMasterStrip(doc, by, 'pan', 0.25)
      setMasterStrip(other, by, 'volume', 0.5)
      sync(doc, other)
      expect(masters.map(({ strip }) => strip)).toEqual([
        { volume: 1, pan: 0 },
        { volume: 1, pan: 0.25 },
        { volume: 0.5, pan: 0.25 }
      ])
    })
  })

  test('read nothing that nothing reads', () => {
    const doc = newProject()
    const later = Id('zz')
    following(doc, (_, registry) => {
      const held = registry.getNodes().size
      doc.transact(() => rawNotes(doc, later).set('n', { tick: 0 }))
      expect(registry.getNodes().size).toBe(held)
    })
  })

  test('stop following once the scope closes', () => {
    const doc = newProject()
    const { atoms, registry } = following(doc, (atoms, registry) => ({ atoms, registry }))
    const values = told(registry, atoms.tempo)
    setTempo(doc, by, 90)
    expect(values).toEqual([120])
  })
})

test('a pattern plays to the end of the last bar its notes sound in, a bar at least', () => {
  const doc = newProject()
  const { clip } = parts(doc)
  following(doc, (atoms, registry) => {
    const bars = () => registry.get(atoms.patternEnd(clip.pattern)) / barTicks
    expect(bars()).toBe(1)
    // Its tail into the second bar.
    addNote(doc, by, clip.id, { tick: Tick(barTicks - 1), key: MidiKey(60), length: 2 })
    expect(bars()).toBe(2)
    addNote(doc, by, clip.id, { tick: Tick(barTicks * 3), key: MidiKey(62), length: barTicks })
    expect(bars()).toBe(4)
    eraseNotes(
      doc,
      by,
      clip.id,
      projectOf(doc).patterns[0].notes.map(({ id }) => id)
    )
    expect(bars()).toBe(1)
  })
})

test('a pattern ends on a bar a loop of the engine holds, however late its last note', () => {
  expect(patternEnd([])).toBe(barTicks)
  expect(patternEnd([{ tick: Tick(barTicks), length: 1 }])).toBe(barTicks * 2)
  const longest = patternEnd([{ tick: Tick(lastTick), length: 1 }])
  expect(longest % barTicks).toBe(0)
  expect(longest).toBeLessThanOrEqual(lastTick)
  expect(longest + barTicks).toBeGreaterThan(lastTick)
})

test('a batched state is seen changed by every way at once: what reads it twice never sees half of a change', () => {
  const registry = AtomRegistry.make()
  const state = batchedState(1)
  const once = Atom.make((get) => get(state))
  const twice = Atom.make((get) => 2 * get(state))
  const both = Atom.make((get) => [get(once), get(twice)] as const)
  const seen: Array<readonly [number, number]> = []
  registry.subscribe(both, (pair) => seen.push(pair), { immediate: true })
  registry.set(state, 2)
  registry.update(state, (n) => n + 1)
  expect(registry.get(state)).toBe(3)
  expect(seen).toEqual([
    [1, 2],
    [2, 4],
    [3, 6]
  ])
})
