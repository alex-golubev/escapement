import { lastTick, MidiKey, Tick } from '@escapement/engine-description'
import { Array, Effect, Option, Order } from 'effect'
import { Atom, AtomRegistry } from 'effect/reactivity'
import { describe, expect, test } from 'vitest'
import {
  addClip,
  addNote,
  addPattern,
  barTicks,
  currentPattern,
  currentPatternOf,
  deletePattern,
  followProject,
  heardChannels,
  heardOf,
  Id,
  type Listening,
  newListening,
  type Played,
  playedOf,
  resizeClip,
  setMute,
  trimClip,
  arrangementEnd,
  toggledMode,
  toggledSolo
} from '../src'
import { by, newProject, projectOf, rawMap } from './project'

const ids = (doc: ReturnType<typeof newProject>) => projectOf(doc).channels.map(({ id }) => id)

describe('who is heard', () => {
  test('without solo, every channel not muted in the document', () => {
    const doc = newProject()
    const [kick, snare, hat, clap] = ids(doc)
    setMute(doc, by, snare, true)
    expect(heardChannels(projectOf(doc).channels, newListening)).toEqual([kick, hat, clap])
  })

  test('with solo, exactly the channels in solo, muted in the document or not', () => {
    const doc = newProject()
    const [kick, snare, hat, clap] = ids(doc)
    setMute(doc, by, hat, true)
    const listening = toggledSolo(toggledSolo(newListening, hat), kick)
    expect(heardChannels(projectOf(doc).channels, listening)).toEqual([kick, hat])
    expect(heardChannels(projectOf(doc).channels, toggledSolo(listening, hat))).toEqual([kick])
    // Out of solo, the muted one is silent again.
    expect(heardChannels(projectOf(doc).channels, toggledSolo(toggledSolo(listening, hat), kick))).toEqual([
      kick,
      snare,
      clap
    ])
  })

  test('without a channel deleted in solo, until it is back', () => {
    const doc = newProject()
    const [kick, snare, hat, clap] = ids(doc)
    const listening = toggledSolo(newListening, snare)
    doc.transact(() => rawMap(doc, 'channels', snare).set('deleted', true))
    expect(heardChannels(projectOf(doc).channels, listening)).toEqual([kick, hat, clap])
    doc.transact(() => rawMap(doc, 'channels', snare).set('deleted', false))
    expect(heardChannels(projectOf(doc).channels, listening)).toEqual([snare])
  })

  test('keeps the channels in solo in one order, whichever went in first', () => {
    const [a, b] = ids(newProject()).toSorted()
    expect(toggledSolo(toggledSolo(newListening, b), a)).toEqual(toggledSolo(toggledSolo(newListening, a), b))
  })

  test('follows the document and the listening as they change', () => {
    const doc = newProject()
    const [kick, snare, hat, clap] = ids(doc)
    const registry = AtomRegistry.make()
    const listening = Atom.make(newListening)
    const told = Effect.runSync(
      followProject(doc).pipe(
        Effect.map((project) => {
          const values: Array<ReadonlyArray<string>> = []
          registry.subscribe(heardOf(project, listening), (heard) => values.push(heard), { immediate: true })
          setMute(doc, by, clap, true)
          registry.update(listening, (state) => toggledSolo(state, snare))
          return values
        }),
        Effect.scoped,
        Effect.provideService(AtomRegistry.AtomRegistry, registry)
      )
    )
    expect(told).toEqual([[kick, snare, hat, clap], [kick, snare, hat], [snare]])
  })
})

describe('the current pattern', () => {
  const chosen = (pattern: Id) => ({ ...newListening, pattern: Option.some(pattern) })

  test('is the one chosen while it is live; once it is deleted, its next live one, or else the one before it', () => {
    const [p1, p2, p3, p4] = [Id('p1'), Id('p2'), Id('p3'), Id('p4')]
    const places = (...deleted: ReadonlyArray<Id>) =>
      [p1, p2, p3, p4].map((id) => ({ id, live: !deleted.includes(id) }))
    expect(currentPattern(places(), chosen(p2))).toEqual(Option.some(p2))
    expect(currentPattern(places(p2), chosen(p2))).toEqual(Option.some(p3))
    expect(currentPattern(places(p2, p3), chosen(p2))).toEqual(Option.some(p4))
    expect(currentPattern(places(p4), chosen(p4))).toEqual(Option.some(p3))
    expect(currentPattern(places(p2, p3, p4), chosen(p3))).toEqual(Option.some(p1))
    expect(currentPattern(places(p1, p2, p3, p4), chosen(p2))).toEqual(Option.none())
  })

  test('with none chosen, or one never there, is the first live one; none without a live one', () => {
    const [p1, p2] = [Id('p1'), Id('p2')]
    const places = [
      { id: p1, live: false },
      { id: p2, live: true }
    ]
    expect(currentPattern(places, newListening)).toEqual(Option.some(p2))
    expect(currentPattern(places, chosen(Id('gone')))).toEqual(Option.some(p2))
    expect(currentPattern([], chosen(p1))).toEqual(Option.none())
  })

  test('stays chosen through solo', () => {
    const listening = toggledSolo(chosen(Id('p2')), Id('c'))
    expect(listening.pattern).toEqual(Option.some('p2'))
  })

  test('follows the patterns and the listening as they change, and comes back with the pattern chosen', () => {
    const doc = newProject()
    const [first] = projectOf(doc).patterns.map(({ id }) => id)
    const registry = AtomRegistry.make()
    const listening = Atom.make(newListening)
    const told = Effect.runSync(
      followProject(doc).pipe(
        Effect.map((project) => {
          const values: Array<Option.Option<Id>> = []
          registry.subscribe(currentPatternOf(project, listening).id, (current) => values.push(current), {
            immediate: true
          })
          const added = Option.getOrThrow(addPattern(doc, by))
          registry.set(listening, chosen(added))
          doc.transact(() => rawMap(doc, 'patterns', added).set('deleted', true))
          doc.transact(() => rawMap(doc, 'patterns', added).set('deleted', false))
          return { values, added }
        }),
        Effect.scoped,
        Effect.provideService(AtomRegistry.AtomRegistry, registry)
      )
    )
    expect(told.values).toEqual([
      Option.some(first),
      Option.some(told.added),
      Option.some(first),
      Option.some(told.added)
    ])
  })
})

describe('what plays', () => {
  test('L goes from Pattern to Arrangement and back, and keeps the rest of the listening', () => {
    const listening = { ...toggledSolo(newListening, Id('c')), pattern: Option.some(Id('p2')) }
    expect(newListening.mode).toBe('pattern')
    expect(toggledMode(listening)).toEqual({ ...listening, mode: 'arrangement' })
    expect(toggledMode(toggledMode(listening))).toEqual(listening)
  })

  test("an arrangement goes round at the end of the bar of its last clip's end, a bar at least, as long as a loop can be", () => {
    const clip = (bar: number, length: number) => ({ tick: bar * barTicks, length })
    expect(arrangementEnd([])).toBe(barTicks)
    expect(arrangementEnd([clip(0, 1)])).toBe(barTicks)
    expect(arrangementEnd([clip(3, barTicks), clip(1, 3 * barTicks + 1)])).toBe(5 * barTicks)
    expect(arrangementEnd([{ tick: lastTick, length: barTicks }])).toBe(Math.floor(lastTick / barTicks) * barTicks)
  })

  test("is the current pattern alone in Pattern mode, and the arrangement's clips in Arrangement mode, each as long as it is, round its pattern's length from where it starts in it", () => {
    const doc = newProject()
    const [first] = projectOf(doc).patterns.map(({ id }) => id)
    const [kick] = ids(doc)
    const registry = AtomRegistry.make()
    const listening = Atom.make(newListening)
    const place = (bar: number) => ({ track: Id('1'), tick: Tick(bar * barTicks) })
    const told = Effect.runSync(
      followProject(doc).pipe(
        Effect.map((project) => {
          const values: Array<Played> = []
          registry.subscribe(playedOf(project, listening), (played) => values.push(played), { immediate: true })
          const second = Option.getOrThrow(addPattern(doc, by))
          addNote(doc, by, second, kick, { tick: Tick(barTicks), key: MidiKey(60), length: 1 })
          const fromItsSecondBar = Option.getOrThrow(addClip(doc, by, second, place(2)))
          trimClip(doc, by, fromItsSecondBar, { tick: Tick(3 * barTicks), length: barTicks, offset: barTicks })
          const first3Bars = Option.getOrThrow(addClip(doc, by, first, place(1)))
          resizeClip(doc, by, first3Bars, 3 * barTicks)
          registry.set(listening, toggledMode(registry.get(listening)))
          deletePattern(doc, by, second)
          registry.set(listening, toggledMode(registry.get(listening)))
          return { values, second }
        }),
        Effect.scoped,
        Effect.provideService(AtomRegistry.AtomRegistry, registry)
      )
    )
    const alone: Played = {
      clips: [{ tick: Tick(0), pattern: first, length: barTicks, period: barTicks, offset: 0 }],
      end: barTicks
    }
    // The clips come by ID, which is random: in the order of their ticks to compare.
    const inTime = ({ clips, end }: Played) => ({ clips: Array.sortWith(clips, ({ tick }) => tick, Order.Number), end })
    expect(told.values.map(inTime)).toEqual([
      alone,
      {
        clips: [
          { tick: Tick(barTicks), pattern: first, length: 3 * barTicks, period: barTicks, offset: 0 },
          { tick: Tick(3 * barTicks), pattern: told.second, length: barTicks, period: 2 * barTicks, offset: barTicks }
        ],
        end: 4 * barTicks
      },
      {
        clips: [{ tick: Tick(barTicks), pattern: first, length: 3 * barTicks, period: barTicks, offset: 0 }],
        end: 4 * barTicks
      },
      alone
    ])
  })

  test("keeps a trimmed clip's rounds where they were as its pattern grows: from as far into its pattern", () => {
    const doc = newProject()
    const [pattern] = projectOf(doc).patterns.map(({ id }) => id)
    const [kick] = ids(doc)
    const registry = AtomRegistry.make()
    const listening = Atom.make<Listening>(toggledMode(newListening))
    const offsets = Effect.runSync(
      followProject(doc).pipe(
        Effect.map((project) => {
          const played = playedOf(project, listening)
          const offsetsNow = () => registry.get(played).clips.map(({ offset, period }) => [offset, period])
          // A bar long, the clip started three bars in: from a round's start.
          const clip = Option.getOrThrow(addClip(doc, by, pattern, { track: Id('1'), tick: Tick(0) }))
          trimClip(doc, by, clip, { tick: Tick(3 * barTicks), length: barTicks, offset: 3 * barTicks })
          const before = offsetsNow()
          // Four bars long now: from its fourth bar, where its rounds put the clip.
          addNote(doc, by, pattern, kick, { tick: Tick(3 * barTicks), key: MidiKey(60), length: 1 })
          return [before, offsetsNow()]
        }),
        Effect.scoped,
        Effect.provideService(AtomRegistry.AtomRegistry, registry)
      )
    )
    expect(offsets).toEqual([[[0, barTicks]], [[3 * barTicks, 4 * barTicks]]])
  })

  test('is nothing in Pattern mode without a live pattern, and nothing in Arrangement mode without a clip, round a bar', () => {
    const doc = newProject()
    const [first] = projectOf(doc).patterns.map(({ id }) => id)
    const registry = AtomRegistry.make()
    const listening = Atom.make<Listening>(toggledMode(newListening))
    const told = Effect.runSync(
      followProject(doc).pipe(
        Effect.map((project) => {
          const played = playedOf(project, listening)
          const arrangement = registry.get(played)
          registry.set(listening, newListening)
          doc.transact(() => rawMap(doc, 'patterns', first).set('deleted', true))
          return [arrangement, registry.get(played)]
        }),
        Effect.scoped,
        Effect.provideService(AtomRegistry.AtomRegistry, registry)
      )
    )
    expect(told).toEqual([
      { clips: [], end: barTicks },
      { clips: [], end: barTicks }
    ])
  })
})
