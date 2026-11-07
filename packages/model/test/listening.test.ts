import { lastTick, MidiKey, Tick } from '@escapement/engine-description'
import { Array, Effect, Option, Order } from 'effect'
import { Atom, AtomRegistry } from 'effect/reactivity'
import { describe, expect, test } from 'vitest'
import {
  addClip,
  addNote,
  arrangementEnd,
  barTicks,
  deleteTrack,
  followProject,
  heardOf,
  heardTracks,
  newListening,
  type Played,
  playedOf,
  resizeClip,
  setMute,
  toggledSolo,
  trimClip
} from '../src'
import { by, newProject, projectOf, rawMap } from './project'

const ids = (doc: ReturnType<typeof newProject>) => projectOf(doc).tracks.map(({ id }) => id)

describe('who is heard', () => {
  test('without solo, every track not muted in the document', () => {
    const doc = newProject()
    const [kick, snare, hat, clap] = ids(doc)
    setMute(doc, by, snare, true)
    expect(heardTracks(projectOf(doc).tracks, newListening)).toEqual([kick, hat, clap])
  })

  test('with solo, exactly the tracks in solo, muted in the document or not', () => {
    const doc = newProject()
    const [kick, snare, hat, clap] = ids(doc)
    setMute(doc, by, hat, true)
    const listening = toggledSolo(toggledSolo(newListening, hat), kick)
    expect(heardTracks(projectOf(doc).tracks, listening)).toEqual([kick, hat])
    expect(heardTracks(projectOf(doc).tracks, toggledSolo(listening, hat))).toEqual([kick])
    // Out of solo, the muted one is silent again.
    expect(heardTracks(projectOf(doc).tracks, toggledSolo(toggledSolo(listening, hat), kick))).toEqual([
      kick,
      snare,
      clap
    ])
  })

  test('without a track deleted in solo, until it is back', () => {
    const doc = newProject()
    const [kick, snare, hat, clap] = ids(doc)
    const listening = toggledSolo(newListening, snare)
    doc.transact(() => rawMap(doc, 'tracks', snare).set('deleted', true))
    expect(heardTracks(projectOf(doc).tracks, listening)).toEqual([kick, hat, clap])
    doc.transact(() => rawMap(doc, 'tracks', snare).set('deleted', false))
    expect(heardTracks(projectOf(doc).tracks, listening)).toEqual([snare])
  })

  test('keeps the tracks in solo in one order, whichever went in first', () => {
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

describe('what plays', () => {
  test("an arrangement goes round at the end of the bar of its last clip's end, a bar at least, as long as a loop can be", () => {
    const clip = (bar: number, length: number) => ({ tick: bar * barTicks, length })
    expect(arrangementEnd([])).toBe(barTicks)
    expect(arrangementEnd([clip(0, 1)])).toBe(barTicks)
    expect(arrangementEnd([clip(3, barTicks), clip(1, 3 * barTicks + 1)])).toBe(5 * barTicks)
    expect(arrangementEnd([{ tick: lastTick, length: barTicks }])).toBe(Math.floor(lastTick / barTicks) * barTicks)
  })

  test("is the arrangement's clips on the live tracks, each as long as it is, round its pattern's length from where it starts in it", () => {
    const doc = newProject()
    const [kick, snare] = ids(doc)
    const [first] = projectOf(doc).clips
    const registry = AtomRegistry.make()
    const place = (track: typeof kick, bar: number) => ({ track, tick: Tick(bar * barTicks) })
    const told = Effect.runSync(
      followProject(doc).pipe(
        Effect.map((project) => {
          const values: Array<Played> = []
          registry.subscribe(playedOf(project), (played) => values.push(played), { immediate: true })
          const fromItsSecondBar = Option.getOrThrow(addClip(doc, by, place(snare, 2)))
          addNote(doc, by, fromItsSecondBar, { tick: Tick(barTicks), key: MidiKey(60), length: 1 })
          trimClip(doc, by, fromItsSecondBar, { tick: Tick(3 * barTicks), length: barTicks, offset: barTicks })
          resizeClip(doc, by, first.id, 3 * barTicks)
          deleteTrack(doc, by, snare)
          return { values, second: Option.getOrThrow(Option.fromUndefinedOr(values.at(-2))) }
        }),
        Effect.scoped,
        Effect.provideService(AtomRegistry.AtomRegistry, registry)
      )
    )
    // The clips come by ID, which is random: in the order of their ticks to compare.
    const inTime = ({ clips, end }: Played) => ({ clips: Array.sortWith(clips, ({ tick }) => tick, Order.Number), end })
    const firstPlayed = (length: number) => ({
      tick: Tick(0),
      track: kick,
      pattern: first.pattern,
      length,
      period: barTicks,
      offset: 0
    })
    const second = told.second.clips.find(({ track }) => track === snare)
    expect(told.values.map(inTime).at(-2)).toEqual({
      clips: [
        firstPlayed(3 * barTicks),
        {
          tick: Tick(3 * barTicks),
          track: snare,
          pattern: second?.pattern,
          length: barTicks,
          period: 2 * barTicks,
          offset: barTicks
        }
      ],
      end: 4 * barTicks
    })
    expect(told.values.map(inTime).at(0)).toEqual({ clips: [firstPlayed(barTicks)], end: barTicks })
    expect(told.values.map(inTime).at(-1)).toEqual({ clips: [firstPlayed(3 * barTicks)], end: 3 * barTicks })
  })

  test("keeps a trimmed clip's rounds where they were as its pattern grows: from as far into its pattern", () => {
    const doc = newProject()
    const [kick] = ids(doc)
    const registry = AtomRegistry.make()
    const offsets = Effect.runSync(
      followProject(doc).pipe(
        Effect.map((project) => {
          const played = playedOf(project)
          const offsetsNow = (clip: string) =>
            registry
              .get(played)
              .clips.filter(({ pattern }) => pattern === clip)
              .map(({ offset, period }) => [offset, period])
          // A bar long, the clip started three bars in: from a round's start.
          const clip = Option.getOrThrow(addClip(doc, by, { track: kick, tick: Tick(barTicks) }))
          const { pattern } = Option.getOrThrow(registry.get(project.clip(clip)))
          trimClip(doc, by, clip, { tick: Tick(3 * barTicks), length: barTicks, offset: 3 * barTicks })
          const before = offsetsNow(pattern)
          // Four bars long now: from its fourth bar, where its rounds put the clip.
          addNote(doc, by, clip, { tick: Tick(3 * barTicks), key: MidiKey(60), length: 1 })
          return [before, offsetsNow(pattern)]
        }),
        Effect.scoped,
        Effect.provideService(AtomRegistry.AtomRegistry, registry)
      )
    )
    expect(offsets).toEqual([[[0, barTicks]], [[3 * barTicks, 4 * barTicks]]])
  })

  test('is nothing without a clip on a live track, round a bar', () => {
    const doc = newProject()
    const [kick] = ids(doc)
    const registry = AtomRegistry.make()
    const told = Effect.runSync(
      followProject(doc).pipe(
        Effect.map((project) => {
          const played = playedOf(project)
          doc.transact(() => rawMap(doc, 'tracks', kick).set('deleted', true))
          return registry.get(played)
        }),
        Effect.scoped,
        Effect.provideService(AtomRegistry.AtomRegistry, registry)
      )
    )
    expect(told).toEqual({ clips: [], end: barTicks })
  })
})
