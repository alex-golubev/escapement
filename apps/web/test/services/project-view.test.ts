import { it } from '@effect/vitest'
import { Tick } from '@escapement/engine-description'
import { addClip, addTrack, createProject, editorOf, followProject, Id, newWriter } from '@escapement/model'
import { Effect, Option } from 'effect'
import { KeyValueStore } from 'effect/persistence'
import { AtomRegistry } from 'effect/reactivity'
import { expect } from 'vitest'
import * as Y from 'yjs'
import { registryOptions } from '../../src/app/core'
import { projectViewOf } from '../../src/services/project-view'
import { centres, type Shown, type View, viewStoreOf } from '../../src/services/view-store'

const writer = newWriter('test')

/** A project of two tracks, the first with a clip, by their IDs. */
const twoTracks = () => {
  const doc = new Y.Doc()
  createProject(doc, writer)
  const [kick, lead] = [addTrack(doc, writer), addTrack(doc, writer)].map(Option.getOrThrow)
  const clip = Option.getOrThrow(addClip(doc, writer, { track: kick, tick: Tick(0) }))
  return { doc, kick, lead, clip }
}

const memory = Effect.provide(Effect.service(KeyValueStore.KeyValueStore), KeyValueStore.layerMemory)

/** The project's view kept in `store`, opened as a page opens it; what it shows now. */
const viewIn = (store: KeyValueStore.KeyValueStore, doc: Y.Doc) =>
  Effect.gen(function* () {
    const registry = yield* AtomRegistry.AtomRegistry
    const kept = yield* viewStoreOf(store, Id('project'), () => true)
    const view = yield* projectViewOf(kept, yield* followProject(doc), centres)
    const shown = () => ({
      centre: registry.get(view.centre),
      below: registry.get(view.below),
      track: registry.get(view.track),
      clip: registry.get(view.clip)
    })
    return { view, shown, chosen: (track: Id) => registry.get(view.isChosen(track)) }
  })

const inRegistry = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(Effect.scoped(effect), AtomRegistry.AtomRegistry, AtomRegistry.make(registryOptions))

const trackShown = (track: Id): Shown => ({ _tag: 'Track', track })

const notesShown = (clip: Id): Shown => ({ _tag: 'Notes', clip })

it.effect(
  "a track shown below is chosen, and so is a clip's when its notes are; the middle turns apart from what is below",
  () =>
    Effect.gen(function* () {
      const { doc, kick, lead, clip } = twoTracks()
      const { view, shown, chosen } = yield* viewIn(yield* memory, doc)
      expect(shown()).toEqual({
        centre: 'arrangement',
        below: Option.none(),
        track: Option.none(),
        clip: Option.none()
      })
      view.turnTo('mixer')
      view.show(lead)
      expect(shown()).toEqual({
        centre: 'mixer',
        below: Option.some(trackShown(lead)),
        track: Option.some(lead),
        clip: Option.none()
      })
      view.open(clip)
      expect(shown()).toEqual({
        centre: 'mixer',
        below: Option.some(notesShown(clip)),
        track: Option.some(kick),
        clip: Option.some(clip)
      })
      expect([chosen(kick), chosen(lead)]).toEqual([true, false])
      view.show(kick)
      expect(shown()).toEqual({
        centre: 'mixer',
        below: Option.some(trackShown(kick)),
        track: Option.some(kick),
        clip: Option.none()
      })
    }).pipe(inRegistry)
)

it.effect('what is shown below, deleted, leaves nothing there; back with an undo, it is shown again', () =>
  Effect.gen(function* () {
    const { doc, kick, clip } = twoTracks()
    const { view, shown } = yield* viewIn(yield* memory, doc)
    const ops = yield* editorOf(doc, writer)
    const nothing = { centre: 'arrangement', below: Option.none(), track: Option.none(), clip: Option.none() }
    view.open(clip)
    ops.eraseClips([clip])
    expect(shown()).toEqual(nothing)
    ops.undo()
    expect(shown().below).toEqual(Option.some(notesShown(clip)))
    view.show(kick)
    ops.deleteTrack(kick)
    expect(shown()).toEqual(nothing)
    ops.undo()
    expect(shown().below).toEqual(Option.some(trackShown(kick)))
  }).pipe(inRegistry)
)

it.effect('each change is kept for the project: opened again, it is shown as it was left', () =>
  Effect.gen(function* () {
    const store = yield* memory
    const { doc, kick, clip } = twoTracks()
    yield* Effect.scoped(
      Effect.gen(function* () {
        const { view } = yield* viewIn(store, doc)
        view.open(clip)
        view.turnTo('mixer')
        yield* Effect.yieldNow
      })
    )
    const { shown } = yield* viewIn(store, doc)
    expect(shown()).toEqual({
      centre: 'mixer',
      below: Option.some(notesShown(clip)),
      track: Option.some(kick),
      clip: Option.some(clip)
    })
  }).pipe(inRegistry)
)

it.effect('a change to what is already shown writes nothing; a saved middle this build has not shows its first', () =>
  Effect.gen(function* () {
    const store = yield* memory
    const { doc, lead } = twoTracks()
    const kept = yield* viewStoreOf(store, Id('project'), () => true)
    const written = { count: 0 }
    const counting = {
      ...kept,
      save: (view: View) =>
        Effect.andThen(
          Effect.sync(() => (written.count += 1)),
          kept.save(view)
        )
    }
    const view = yield* projectViewOf(counting, yield* followProject(doc), centres)
    view.show(lead)
    view.turnTo('debug')
    yield* Effect.yieldNow
    expect(written.count).toBe(2)
    view.show(lead)
    view.turnTo('debug')
    yield* Effect.yieldNow
    expect(written.count).toBe(2)
    const registry = yield* AtomRegistry.AtomRegistry
    const reopened = yield* projectViewOf(
      yield* viewStoreOf(store, Id('project'), () => true),
      yield* followProject(doc),
      ['arrangement', 'mixer']
    )
    expect([registry.get(reopened.centre), reopened.centres]).toEqual(['arrangement', ['arrangement', 'mixer']])
  }).pipe(inRegistry)
)
