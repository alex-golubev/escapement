import { compile } from '@escapement/compiler'
import { type Command, NodeHandle, noPlace, setStripParam, type Transaction } from '@escapement/engine'
import { plugins, Sha256 } from '@escapement/engine-description'
import { addTrack, createProject, editorOf, HoldTarget, newWriter, readProject, setTrackStrip } from '@escapement/model'
import { Cause, Effect, Logger, Option } from 'effect'
import { Atom, AtomRegistry } from 'effect/reactivity'
import { expect, test } from 'vitest'
import * as Y from 'yjs'
import { registryOptions } from '../../src/app/core'
import { sessionOf } from '../../src/services/session'
import { turnsOf } from '../../src/services/turns'
import { savedIn } from '../saved-in'

/** Another client. */
const elsewhere = newWriter('elsewhere')

/** A new project with a kick's track, as another client makes it. */
const withKick = (doc: Y.Doc) => {
  createProject(doc, elsewhere)
  addTrack(doc, elsewhere, { plugin: plugins.sampler, sounds: { sample: Sha256('0d'.repeat(32)) } })
}

/** About a second of a pointer's moves. */
const moves = Array.from({ length: 60 }, (_, i) => 0.79 - i / 100)

test('a turn plays each move at once and writes the document once, its last value on release', () =>
  Effect.gen(function* () {
    const registry = yield* AtomRegistry.AtomRegistry
    const doc = new Y.Doc()
    withKick(doc)
    const session = yield* sessionOf(savedIn(doc), newWriter('page'))
    const turns = yield* turnsOf(yield* editorOf(doc, session.writer), session.holds)
    const sent: Array<Transaction> = []
    yield* compile(
      session.project,
      {
        listening: session.listening,
        holds: session.holds,
        playing: Atom.make(false),
        place: Atom.make(noPlace),
        auditions: session.auditions
      },
      {
        send: (transaction) => sent.push(transaction) > 0,
        storeSample: () => Effect.void,
        evictSample: () => true,
        running: Atom.make(true)
      },
      { load: () => Option.none(), show: () => Effect.void }
    )
    const writes = { count: 0 }
    doc.on('update', () => {
      writes.count += 1
    })
    const track = readProject(doc).value.tracks[0].id
    const volume = () => readProject(doc).value.tracks[0].strip.volume
    // The second node made: the track's fader, after its instrument.
    const node = NodeHandle(2)
    const from = sent.length

    const turn = turns.begin(HoldTarget.TrackStrip({ track, param: 'volume' }), 0.8)
    moves.forEach(turn.move)
    turn.move(0.1)
    expect(writes.count).toBe(0)
    turn.release()
    expect(writes.count).toBe(1)
    // The engine goes straight on from the hold, never back to the older value.
    const commands = sent.slice(from).flatMap(({ commands = [] }): ReadonlyArray<Command> => commands)
    expect(commands).toEqual([...moves, 0.1].map((value) => setStripParam(node, 'volume', value)))
    expect(volume()).toBe(0.1)
    expect(registry.get(session.holds)).toEqual([])
    const released = writes.count
    setTrackStrip(doc, elsewhere, track, 'volume', 0.5)
    turn.move(0.3)
    turn.release()
    expect(writes.count).toBe(released + 1)
    expect(volume()).toBe(0.5)
    expect(registry.get(session.holds)).toEqual([])
  }).pipe(
    Effect.scoped,
    Effect.provideService(AtomRegistry.AtomRegistry, AtomRegistry.make(registryOptions)),
    Effect.runPromise
  ))

test('a second turn of a control ends the first, which writes its last value, and keeps its own hold', () =>
  Effect.gen(function* () {
    const registry = yield* AtomRegistry.AtomRegistry
    const doc = new Y.Doc()
    withKick(doc)
    const session = yield* sessionOf(savedIn(doc), newWriter('page'))
    const turns = yield* turnsOf(yield* editorOf(doc, session.writer), session.holds)
    const track = readProject(doc).value.tracks[0].id
    const target = HoldTarget.TrackStrip({ track, param: 'volume' })
    const volume = () => Option.some(readProject(doc).value.tracks[0].strip.volume)

    const first = turns.begin(target, 0.8)
    first.move(0.6)
    const second = turns.begin(HoldTarget.TrackStrip({ track, param: 'volume' }), 0.6)
    expect(volume()).toEqual(Option.some(0.6))
    second.move(0.4)
    first.release()
    expect(registry.get(session.holds)).toEqual([{ target, value: 0.4 }])
    second.release()
    expect(volume()).toEqual(Option.some(0.4))
    expect(registry.get(session.holds)).toEqual([])
  }).pipe(
    Effect.scoped,
    Effect.provideService(AtomRegistry.AtomRegistry, AtomRegistry.make(registryOptions)),
    Effect.runPromise
  ))

test('a double click ends a turn of its control, and its value stays', () =>
  Effect.gen(function* () {
    const registry = yield* AtomRegistry.AtomRegistry
    const doc = new Y.Doc()
    withKick(doc)
    const session = yield* sessionOf(savedIn(doc), newWriter('page'))
    const turns = yield* turnsOf(yield* editorOf(doc, session.writer), session.holds)
    const track = readProject(doc).value.tracks[0].id
    const target = HoldTarget.TrackStrip({ track, param: 'volume' })
    const volume = () => Option.some(readProject(doc).value.tracks[0].strip.volume)

    const turn = turns.begin(target, 0.8)
    turn.move(0.6)
    turns.set(target, 0.5)
    expect(registry.get(session.holds)).toEqual([])
    turn.move(0.4)
    turn.release()
    expect(volume()).toEqual(Option.some(0.5))
  }).pipe(
    Effect.scoped,
    Effect.provideService(AtomRegistry.AtomRegistry, AtomRegistry.make(registryOptions)),
    Effect.runPromise
  ))

test('a turn whose write throws still lets go and ends its action, and the error is logged', () => {
  const logged: Array<Logger.Options<unknown>> = []
  return Effect.gen(function* () {
    const registry = yield* AtomRegistry.AtomRegistry
    const doc = new Y.Doc()
    withKick(doc)
    const session = yield* sessionOf(savedIn(doc), newWriter('page'))
    const editor = yield* editorOf(doc, session.writer)
    registry.mount(editor.canUndo)
    const turns = yield* turnsOf(editor, session.holds)
    const track = readProject(doc).value.tracks[0].id
    editor.setMute(track, true)
    // As storage closed under the page would.
    doc.on('update', () => {
      throw new Error('Storage closed')
    })

    const turn = turns.begin(HoldTarget.TrackStrip({ track, param: 'volume' }), 0.8)
    turn.move(0.6)
    expect(registry.get(editor.canUndo)).toBe(false)
    turn.release()
    expect(logged.map(({ cause }) => Cause.pretty(cause)).join('\n')).toContain('Storage closed')
    expect(registry.get(session.holds)).toEqual([])
    expect(registry.get(editor.canUndo)).toBe(true)
  }).pipe(
    Effect.provide(Logger.layer([Logger.make((options) => void logged.push(options))])),
    Effect.scoped,
    Effect.provideService(AtomRegistry.AtomRegistry, AtomRegistry.make(registryOptions)),
    Effect.runPromise
  )
})
