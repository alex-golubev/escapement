import { Effect, Option } from 'effect'
import { Atom, AtomRegistry } from 'effect/reactivity'
import { describe, expect, test } from 'vitest'
import * as Y from 'yjs'
import { lastTick, MidiKey, Tick } from '@escapement/engine-description'
import {
  addClip,
  addNote,
  addPattern,
  barTicks,
  batchedState,
  byContent,
  deleteChannel,
  deletePattern,
  eraseClips,
  eraseNotes,
  followProject,
  Id,
  moveClip,
  type ProjectAtoms,
  patternEnd,
  setChannelStrip,
  setInsertMute,
  setInsertStrip,
  setMasterParam,
  setTempo,
  stepTicks,
  toggleStep
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
        const parts: ReadonlyArray<Atom.Atom<unknown>> = [
          atoms.tempo,
          atoms.channelIds,
          atoms.patternPlaces,
          atoms.patternIds,
          atoms.clips,
          atoms.master
        ]
        const { channels, patterns } = projectOf(doc)
        const ofChannels = channels.map(({ id }) => atoms.channel(id))
        const ofPatterns = patterns.flatMap(({ id }) => [atoms.pattern(id), atoms.patternEnd(id)])
        ;[...parts, ...ofChannels, ...ofPatterns].forEach((atom) => registry.mount(atom))
        return use(atoms, registry)
      }),
      Effect.scoped,
      Effect.provideService(AtomRegistry.AtomRegistry, registry)
    )
  )
}

const ids = (doc: Y.Doc) => {
  const { channels, patterns } = projectOf(doc)
  return { channels: channels.map(({ id }) => id), pattern: patterns[0].id }
}

describe('the atoms of a project', () => {
  test('read each part as reading the whole project does', () => {
    const doc = newProjectWithSynth()
    rawMap(doc, 'channels', synthOf(doc).id, 'instrument', 'params').set('osc1.shape', 'saw')
    const project = projectOf(doc)
    following(doc, (atoms, registry) => {
      expect(registry.get(atoms.tempo)).toBe(project.tempo)
      expect(registry.get(atoms.channelIds)).toEqual(project.channels.map(({ id }) => id))
      project.channels.forEach((channel) =>
        expect(registry.get(atoms.channel(channel.id))).toEqual(Option.some(channel))
      )
      expect(registry.get(atoms.patternIds)).toEqual(project.patterns.map(({ id }) => id))
      project.patterns.forEach((pattern) =>
        expect(registry.get(atoms.pattern(pattern.id))).toEqual(Option.some(pattern))
      )
      expect(registry.get(atoms.master)).toEqual(project.master)
    })
  })

  test('follow every operation, and tell what depends on two parts once a transaction', () => {
    const doc = newProject()
    const { channels, pattern } = ids(doc)
    following(doc, (atoms, registry) => {
      const volumes = byContent((get) =>
        channels.map((id) => Option.map(get(atoms.channel(id)), (channel) => channel.strip.volume))
      )
      const values = told(registry, volumes)
      doc.transact(() => {
        setChannelStrip(doc, by, channels[0], 'volume', 0.1)
        setChannelStrip(doc, by, channels[1], 'volume', 0.2)
      })
      expect(values).toHaveLength(2)
      expect(values[1]).toEqual([Option.some(0.1), Option.some(0.2), ...values[0].slice(2)])
      setTempo(doc, by, 90)
      expect(registry.get(atoms.tempo)).toBe(90)
      toggleStep(doc, by, pattern, channels[0], 3)
      expect(Option.map(registry.get(atoms.pattern(pattern)), ({ notes }) => notes.map(({ tick }) => tick))).toEqual(
        Option.some([3 * stepTicks])
      )
    })
  })

  test('tell nothing to what a change leaves as it was', () => {
    const doc = newProject()
    const { channels, pattern } = ids(doc)
    following(doc, (atoms, registry) => {
      const patterns = told(registry, atoms.pattern(pattern))
      const patternIds = told(registry, atoms.patternIds)
      const order = told(registry, atoms.channelIds)
      setChannelStrip(doc, by, channels[0], 'volume', 0.1)
      // Written again as it is.
      doc.transact(() => rawMap(doc, 'meta').set('bpm', 120))
      expect(patterns).toHaveLength(1)
      expect(order).toHaveLength(1)
      toggleStep(doc, by, pattern, channels[0], 0)
      expect(patterns).toHaveLength(2)
      expect(patternIds).toHaveLength(1)
      expect(order).toHaveLength(1)
    })
  })

  test('follow channels deleted, removed, added and moved', () => {
    const doc = newProject()
    const { channels } = ids(doc)
    following(doc, (atoms, registry) => {
      doc.transact(() => rawMap(doc, 'channels', channels[0]).set('deleted', true))
      expect(registry.get(atoms.channelIds)).toEqual(channels.slice(1))
      expect(registry.get(atoms.channel(channels[0]))).toEqual(Option.none())
      doc.transact(() => doc.getMap('channels').delete(channels[1]))
      expect(registry.get(atoms.channelIds)).toEqual(channels.slice(2))
      doc.transact(() => rawMap(doc, 'channels', channels[3]).set('order', ' '))
      expect(registry.get(atoms.channelIds)).toEqual([channels[3], channels[2]])
      const added = Id('added')
      doc.transact(() => doc.getMap('channels').set(added, new Y.Map(Object.entries({ order: '~', deleted: false }))))
      expect(registry.get(atoms.channelIds)).toEqual([channels[3], channels[2], added])
      expect(Option.map(registry.get(atoms.channel(added)), ({ instrument }) => instrument)).toEqual(
        Option.some(Option.none())
      )
    })
  })

  test('read a channel again when a new one takes its ID, and the master as it changes', () => {
    const doc = newProject()
    const { channels } = ids(doc)
    const { slot } = parts(doc)
    following(doc, (atoms, registry) => {
      const names = told(registry, atoms.channel(channels[0]))
      const masters = told(registry, atoms.master)
      doc.transact(() =>
        doc.getMap('channels').set(channels[0], new Y.Map(Object.entries({ name: 'Tom', order: 'a0', deleted: false })))
      )
      expect(names.map((channel) => Option.map(channel, ({ name }) => name))).toEqual([
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

  test('follow patterns deleted, removed, added and moved, and the notes of one added', () => {
    const doc = newProject()
    const { channels, pattern } = ids(doc)
    following(doc, (atoms, registry) => {
      const added = Option.getOrThrow(addPattern(doc, by))
      expect(registry.get(atoms.patternIds)).toEqual([pattern, added])
      toggleStep(doc, by, added, channels[0], 2)
      expect(Option.map(registry.get(atoms.pattern(added)), ({ notes }) => notes.map(({ tick }) => tick))).toEqual(
        Option.some([2 * stepTicks])
      )
      doc.transact(() => rawMap(doc, 'patterns', added).set('order', ' '))
      expect(registry.get(atoms.patternIds)).toEqual([added, pattern])
      doc.transact(() => rawMap(doc, 'patterns', pattern).set('deleted', true))
      expect(registry.get(atoms.patternIds)).toEqual([added])
      // Where a deleted one stood stays known.
      expect(registry.get(atoms.patternPlaces)).toEqual([
        { id: added, live: true },
        { id: pattern, live: false }
      ])
      expect(registry.get(atoms.pattern(pattern))).toEqual(Option.none())
      doc.transact(() => doc.getMap('patterns').delete(added))
      expect(registry.get(atoms.patternIds)).toEqual([])
    })
  })

  test('follow clips put, moved and erased, and leave out those of a pattern deleted', () => {
    const doc = newProject()
    const { pattern } = ids(doc)
    const at = (track: string, bar: number) => ({ track: Id(track), tick: Tick(bar * barTicks) })
    following(doc, (atoms, registry) => {
      const clips = () => registry.get(atoms.clips).map(({ track, tick, pattern }) => ({ track, tick, pattern }))
      const clip = Option.getOrThrow(addClip(doc, by, pattern, at('1', 0)))
      expect(clips()).toEqual([{ track: '1', tick: 0, pattern }])
      moveClip(doc, by, clip, at('2', 3))
      expect(clips()).toEqual([{ track: '2', tick: 3 * barTicks, pattern }])
      const other = Option.getOrThrow(addPattern(doc, by))
      const second = Option.getOrThrow(addClip(doc, by, other, at('1', 1)))
      expect(registry.get(atoms.clips).map(({ id }) => id)).toEqual([clip, second].toSorted())
      deletePattern(doc, by, other)
      expect(clips()).toEqual([{ track: '2', tick: 3 * barTicks, pattern }])
      eraseClips(doc, by, [clip])
      expect(clips()).toEqual([])
      doc.transact(() => rawMap(doc, 'patterns', other).set('deleted', false))
      expect(registry.get(atoms.clips).map(({ id }) => id)).toEqual([second])
    })
  })

  test('follow the notes of a pattern whose map comes from another client before it is read here', () => {
    const doc = newProject()
    const other = new Y.Doc()
    sync(doc, other)
    const { channels, pattern } = ids(doc)
    following(doc, (atoms, registry) => {
      const added = Option.getOrThrow(addPattern(other, by))
      toggleStep(other, by, added, channels[0], 1)
      sync(doc, other)
      expect(registry.get(atoms.patternIds)).toEqual([pattern, added])
      const notes = told(registry, atoms.pattern(added))
      toggleStep(other, by, added, channels[0], 3)
      sync(doc, other)
      const steps = (one: (typeof notes)[number]) =>
        Option.map(one, ({ notes }) => notes.map(({ tick }) => tick / stepTicks).toSorted((a, b) => a - b))
      expect(notes.map(steps)).toEqual([Option.some([1]), Option.some([1, 3])])
    })
  })

  test('follow an insert and the master as their strips change, and an insert another client writes first', () => {
    const doc = newProject()
    const other = new Y.Doc()
    sync(doc, other)
    following(doc, (atoms, registry) => {
      const third = told(registry, atoms.insert(Id('3')))
      const ninth = told(registry, atoms.insert(Id('9')))
      const masters = told(registry, atoms.master)
      setInsertStrip(doc, by, Id('3'), 'volume', 0.5)
      setInsertMute(other, by, Id('9'), true)
      sync(doc, other)
      setInsertStrip(doc, by, Id('master'), 'pan', 0.25)
      expect(third.map(({ strip }) => strip.volume)).toEqual([1, 0.5])
      expect(ninth.map(({ mute }) => mute)).toEqual([false, true])
      expect(masters.map(({ strip }) => strip.pan)).toEqual([0, 0.25])
    })
  })

  test('read an insert the document holds nothing of without making a map of its top for it', () => {
    const doc = newProject()
    following(doc, (atoms, registry) => {
      const shared = doc.share.size
      expect(told(registry, atoms.insert(Id('77')))).toEqual([{ id: '77', strip: { volume: 1, pan: 0 }, mute: false }])
      expect(doc.share.size).toBe(shared)
      expect(doc.share.has('mixer/77')).toBe(false)
    })
  })

  test('read nothing that nothing reads', () => {
    const doc = newProject()
    const later = Id('zz')
    following(doc, (_, registry) => {
      doc.transact(() => doc.getMap('patterns').set(later, new Y.Map(Object.entries({ name: 'Later', order: 'b' }))))
      const held = registry.getNodes().size
      doc.transact(() => rawNotes(doc, later).set('n', { channel: 'c', tick: 0 }))
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

test("a pattern plays to the end of the last bar its live channels' notes sound in, a bar at least", () => {
  const doc = newProject()
  const { channel, pattern } = parts(doc)
  const [, other] = projectOf(doc).channels
  following(doc, (atoms, registry) => {
    const bars = () => registry.get(atoms.patternEnd(pattern.id)) / barTicks
    expect(bars()).toBe(1)
    // Its tail into the second bar.
    addNote(doc, by, pattern.id, channel.id, { tick: Tick(barTicks - 1), key: MidiKey(60), length: 2 })
    expect(bars()).toBe(2)
    addNote(doc, by, pattern.id, other.id, { tick: Tick(barTicks * 3), key: MidiKey(60), length: barTicks })
    expect(bars()).toBe(4)
    deleteChannel(doc, by, other.id)
    expect(bars()).toBe(2)
    eraseNotes(
      doc,
      by,
      pattern.id,
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
