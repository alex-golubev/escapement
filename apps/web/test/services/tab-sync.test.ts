import 'fake-indexeddb/auto'
import { compile } from '@escapement/compiler'
import { Command, type Transaction } from '@escapement/engine'
import { defaultTempo, Sha256 } from '@escapement/engine-description'
import {
  createProject,
  editorOf,
  type Holds,
  HoldTarget,
  heldValue,
  holding,
  newWriter,
  noHolds,
  readProject,
  setTempo,
  toggleStep
} from '@escapement/model'
import { Boolean, Cause, Effect, Equal, Layer, Logger, Option, Schedule, type Scope } from 'effect'
import { SecureRandom } from 'effect/crypto'
import { Atom, AtomRegistry } from 'effect/reactivity'
import * as encoding from 'lib0/encoding'
import { afterEach, expect, test, vi } from 'vitest'
import { Awareness, encodeAwarenessUpdate } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { registryOptions } from '../../src/app/core'
import { tabChannelsLayer } from '../../src/browser/tab-channels'
import { Page } from '../../src/services/page'
import { sessionOf } from '../../src/services/session'
import { presenceMessage, projectChannel, TabChannels, TabMessageBroken, tabSyncOf } from '../../src/services/tab-sync'
import { turnsOf } from '../../src/services/turns'
import { savedIn } from '../saved-in'

const by = newWriter('test')

const channels = ['Kick', 'Snare'].map((name, i) => ({ name, sound: Sha256(`${i}e`.repeat(32)) }))

const projectOf = (doc: Y.Doc) => readProject(doc).value

const tempoOf = (doc: Y.Doc) => projectOf(doc).tempo

const notesOf = (doc: Y.Doc) => projectOf(doc).patterns.flatMap(({ notes }) => notes)

/** Switches the step of the first channel in the first pattern. */
const toggle = (doc: Y.Doc, step: number) => {
  const { patterns, channels } = projectOf(doc)
  toggleStep(doc, by, patterns[0].id, channels[0].id, step)
}

/** Run with the browser's channels between tabs: Node has `BroadcastChannel` too. */
const run = <A>(
  program: Effect.Effect<A, never, Scope.Scope | AtomRegistry.AtomRegistry | SecureRandom.SecureRandom | TabChannels>
) =>
  program.pipe(
    Effect.scoped,
    Effect.provideService(AtomRegistry.AtomRegistry, AtomRegistry.make(registryOptions)),
    Effect.provide(Layer.merge(SecureRandom.layerWebCrypto, tabChannelsLayer)),
    Effect.runPromise
  )

/** What the test's pages log, in place of the console. */
const logInto = (logged: Array<Logger.Options<unknown>>) =>
  Logger.layer([Logger.make((options) => void logged.push(options))])

/** A channel name of the test's own, so the tabs of two tests never meet. */
const freshName = Effect.flatMap(SecureRandom.SecureRandom, (random) => random.uuidV4())

/** Another tab's messages come as tasks of their own. */
const until = (done: () => boolean) =>
  Effect.sync(done).pipe(
    Effect.repeat({ until: (isDone) => isDone, schedule: Schedule.spaced('1 millis') }),
    Effect.timeout('2 seconds'),
    Effect.orDie
  )

/** Long past when a message posted before would have come. */
const settled = Effect.sleep('50 millis')

const newProject = () => {
  const doc = new Y.Doc()
  createProject(doc, by, channels)
  return doc
}

/** The same project, as another tab loads it from the storage they share. */
const loaded = (doc: Y.Doc) => {
  const copy = new Y.Doc()
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc))
  return copy
}

/** A page open on the project in `doc`, in step with its other tabs under `name`, and the page it hides and shows. */
const pageOf = (name: string, doc: Y.Doc) =>
  Effect.gen(function* () {
    const session = yield* sessionOf(savedIn(doc), newWriter('page'))
    const page = new EventTarget()
    const tabs = yield* tabSyncOf(name, session).pipe(Effect.provideService(Page, page))
    return { session, tabs, page }
  })

/** What goes over the project's channel, as one who only listens hears it. */
const listening = (name: string, doc: Y.Doc) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const channel = new BroadcastChannel(projectChannel(name, doc))
      const messages: Array<Uint8Array> = []
      channel.onmessage = ({ data }) => messages.push(data)
      return { channel, messages }
    }),
    ({ channel }) => Effect.sync(() => channel.close())
  )

const kickVolume = (doc: Y.Doc) => HoldTarget.ChannelStrip({ channel: projectOf(doc).channels[0].id, param: 'volume' })

afterEach(() => {
  vi.restoreAllMocks()
})

test('a change in one tab reaches the other tabs of its project as it is made, whichever made it', () =>
  run(
    Effect.gen(function* () {
      const name = yield* freshName
      const here = newProject()
      const [there, third] = [loaded(here), loaded(here)]
      yield* pageOf(name, here)
      yield* pageOf(name, there)
      yield* pageOf(name, third)
      setTempo(here, by, 150)
      yield* until(() => tempoOf(there) === 150 && tempoOf(third) === 150)
      toggle(there, 3)
      yield* until(() => notesOf(here).length === 1 && notesOf(third).length === 1)
      expect(projectOf(here)).toEqual(projectOf(there))
      expect(projectOf(third)).toEqual(projectOf(there))
    })
  ))

test('a change goes out once: what came from another tab is not sent on', () =>
  run(
    Effect.gen(function* () {
      const name = yield* freshName
      const here = newProject()
      const there = loaded(here)
      yield* pageOf(name, here)
      yield* pageOf(name, there)
      yield* settled
      const heard = yield* listening(name, here)
      setTempo(here, by, 150)
      yield* until(() => tempoOf(there) === 150)
      yield* settled
      expect(heard.messages).toHaveLength(1)
    })
  ))

test('Sync off takes a tab out: it neither sends nor gets; Sync on brings each what the other did meanwhile', () =>
  run(
    Effect.gen(function* () {
      const registry = yield* AtomRegistry.AtomRegistry
      const name = yield* freshName
      const here = newProject()
      const there = loaded(here)
      yield* pageOf(name, here)
      const { tabs } = yield* pageOf(name, there)
      expect(registry.get(tabs.on)).toBe(true)
      yield* tabs.toggle
      expect(registry.get(tabs.on)).toBe(false)
      setTempo(here, by, 150)
      toggle(there, 3)
      yield* settled
      expect(tempoOf(there)).toBe(defaultTempo)
      expect(notesOf(here)).toHaveLength(0)
      yield* tabs.toggle
      expect(registry.get(tabs.on)).toBe(true)
      yield* until(() => tempoOf(there) === 150 && notesOf(here).length === 1)
      expect(projectOf(here)).toEqual(projectOf(there))
    })
  ))

test('a bug in keeping in step is logged and takes the tab out, as Sync off does; Sync on brings it back', () => {
  const logged: Array<Logger.Options<unknown>> = []
  return run(
    Effect.gen(function* () {
      const registry = yield* AtomRegistry.AtomRegistry
      const name = yield* freshName
      const here = newProject()
      const there = loaded(here)
      const { tabs } = yield* pageOf(name, here)
      yield* pageOf(name, there)
      yield* settled
      // The next change can't go out.
      vi.spyOn(BroadcastChannel.prototype, 'postMessage').mockImplementationOnce(() => {
        throw new Error('A bug')
      })
      setTempo(here, by, 150)
      yield* until(() => !registry.get(tabs.on))
      expect(logged.map(({ message }) => message)).toEqual([['A bug took the page out of step with the other tabs']])
      expect(Cause.pretty(logged[0].cause)).toContain('A bug')
      yield* settled
      expect(tempoOf(there)).toBe(defaultTempo)
      yield* tabs.toggle
      yield* until(() => tempoOf(there) === 150)
    }).pipe(Effect.provide(logInto(logged)))
  )
})

test('the same step switched on in two tabs apart is two notes once they merge, and one click switches both off', () =>
  run(
    Effect.gen(function* () {
      const name = yield* freshName
      const here = newProject()
      const there = loaded(here)
      yield* pageOf(name, here)
      const { tabs } = yield* pageOf(name, there)
      yield* tabs.toggle
      toggle(here, 5)
      toggle(there, 5)
      yield* tabs.toggle
      yield* until(() => notesOf(here).length === 2 && notesOf(there).length === 2)
      toggle(there, 5)
      yield* until(() => notesOf(here).length === 0)
      expect(notesOf(there)).toHaveLength(0)
    })
  ))

test('a message that is not one, or is broken, is logged and left out, and the tabs stay in step', () => {
  const logged: Array<Logger.Options<unknown>> = []
  return run(
    Effect.gen(function* () {
      // An update Yjs can't read is logged by y-protocols, to the console.
      const yjsErrors = vi.spyOn(console, 'error').mockImplementation(() => {})
      const name = yield* freshName
      const here = newProject()
      const there = loaded(here)
      yield* pageOf(name, here)
      yield* pageOf(name, there)
      const { channel: stranger } = yield* listening(name, here)
      // Not a message; one of no kind the channel has; an update of bytes Yjs can't read; presence that can't be read.
      stranger.postMessage('hello')
      stranger.postMessage(new Uint8Array([9]))
      stranger.postMessage(new Uint8Array([0, 2, 3, 1, 2, 3]))
      stranger.postMessage(new Uint8Array([presenceMessage, 3, 1, 2, 3]))
      // Each tab logs each.
      yield* until(() => logged.length >= 6 && yjsErrors.mock.calls.length >= 2)
      expect(logged.flatMap(({ message }) => message)).toEqual(Array(6).fill(expect.any(TabMessageBroken)))
      setTempo(here, by, 150)
      yield* until(() => tempoOf(there) === 150)
    }).pipe(Effect.provide(logInto(logged)))
  )
})

test('tabs of different projects never meet, such as a new one made since the saved one did not load', () =>
  run(
    Effect.gen(function* () {
      const name = yield* freshName
      const here = newProject()
      const there = loaded(here)
      const other = newProject()
      yield* pageOf(name, here)
      yield* pageOf(name, there)
      yield* pageOf(name, other)
      setTempo(here, by, 150)
      toggle(other, 3)
      yield* until(() => tempoOf(there) === 150)
      yield* settled
      expect(projectOf(other).channels).toHaveLength(2)
      expect(tempoOf(other)).toBe(defaultTempo)
      expect(notesOf(here)).toHaveLength(0)
      expect(projectOf(here).channels).toHaveLength(2)
    })
  ))

test('projects made before projects had IDs keep in step on one channel, apart from those that have one', () =>
  run(
    Effect.gen(function* () {
      const name = yield* freshName
      const old = newProject()
      old.getMap('meta').delete('id')
      const oldThere = loaded(old)
      const other = newProject()
      yield* pageOf(name, old)
      yield* pageOf(name, oldThere)
      yield* pageOf(name, other)
      setTempo(old, by, 150)
      yield* until(() => tempoOf(oldThere) === 150)
      yield* settled
      expect(tempoOf(other)).toBe(defaultTempo)
    })
  ))

test("a knob turned in one tab plays in another's engine as it turns, never going back to an older value", () =>
  run(
    Effect.gen(function* () {
      const registry = yield* AtomRegistry.AtomRegistry
      const name = yield* freshName
      const here = newProject()
      const there = loaded(here)
      const a = yield* pageOf(name, here)
      const b = yield* pageOf(name, there)
      const turns = yield* turnsOf(yield* editorOf(here, a.session.writer), a.session.holds)
      const sent: Array<Transaction> = []
      yield* compile(
        b.session.project,
        {
          listening: b.session.listening,
          holds: b.session.played,
          playing: Atom.make(false),
          auditions: b.session.auditions
        },
        {
          send: (transaction) => sent.push(transaction) > 0,
          storeSample: () => Effect.void,
          evictSample: () => true,
          running: Atom.make(true)
        },
        { load: () => Option.none(), show: () => Effect.void }
      )
      const volumes = () =>
        sent.flatMap(({ commands = [] }) => commands.filter(Command.$is('SetStripParam')).map(({ value }) => value))
      const target = kickVolume(here)
      const shown = () => registry.get(b.session.held(kickVolume(there)))
      const moves = [0.7, 0.6, 0.5, 0.4, 0.3]
      const turn = turns.begin(target, 0.8)
      yield* Effect.forEach(
        moves,
        (value) => Effect.sync(() => turn.move(value)).pipe(Effect.andThen(Effect.sleep('15 millis'))),
        { discard: true }
      )
      yield* until(() => Option.getOrUndefined(shown()) === 0.3)
      expect(volumes().at(-1)).toBe(0.3)
      turn.release()
      yield* until(() => registry.get(b.session.heldElsewhere).length === 0)
      expect(shown()).toEqual(Option.none())
      yield* settled
      // Some moves went between others; each that did, in order, and the document's last value never undone.
      const played = volumes()
      expect(played.length).toBeGreaterThan(1)
      expect(played.every((value) => moves.includes(value))).toBe(true)
      expect(played).toEqual([...played].sort((x, y) => y - x))
      expect(played.at(-1)).toBe(0.3)
      expect(projectOf(there).channels[0].strip.volume).toBe(0.3)
    })
  ))

test('moves go out at most every interval, the latest each time; a control let go goes out at once', () =>
  run(
    Effect.gen(function* () {
      const registry = yield* AtomRegistry.AtomRegistry
      const name = yield* freshName
      const here = newProject()
      const there = loaded(here)
      const a = yield* pageOf(name, here)
      const b = yield* pageOf(name, there)
      yield* settled
      const posts = vi.spyOn(BroadcastChannel.prototype, 'postMessage')
      const told = () =>
        posts.mock.calls.filter(([message]) => message instanceof Uint8Array && message[0] === presenceMessage).length
      const seen: Array<number | undefined> = []
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          registry.subscribe(b.session.held(kickVolume(there)), (held) => seen.push(Option.getOrUndefined(held)), {
            immediate: true
          })
        ),
        (unsubscribe) => Effect.sync(unsubscribe)
      )
      const target = kickVolume(here)
      const hold = (value: number) => registry.set(a.session.holds, holding(noHolds, target, value))
      // The interval has passed: told at once; the moves right after wait for it, and only the latest goes.
      hold(0.1)
      expect(told()).toBe(1)
      hold(0.2)
      hold(0.3)
      expect(told()).toBe(1)
      yield* until(() => seen.at(-1) === 0.3)
      expect(told()).toBe(2)
      // Let go before the move ahead of it is told: at once, and the move never.
      hold(0.4)
      hold(0.45)
      const before = told()
      registry.set(a.session.holds, noHolds)
      expect(told()).toBe(before + 1)
      yield* until(() => registry.get(b.session.heldElsewhere).length === 0)
      yield* settled
      expect(told()).toBe(before + 1)
      expect(seen).not.toContain(0.2)
      expect(seen).not.toContain(0.45)
    })
  ))

test("a tab's own turn plays over another's; of two others turning one control, every tab plays the same", () =>
  run(
    Effect.gen(function* () {
      const registry = yield* AtomRegistry.AtomRegistry
      const name = yield* freshName
      const here = newProject()
      const pages = yield* Effect.forEach([here, loaded(here), loaded(here)], (doc) => pageOf(name, doc))
      const [a, b, c] = pages
      const target = kickVolume(here)
      registry.set(a.session.holds, holding(noHolds, target, 0.2))
      registry.set(b.session.holds, holding(noHolds, target, 0.6))
      registry.set(c.session.holds, holding(noHolds, target, 0.9))
      // Of the two others, the one with the lower client number, whichever is heard first; and it stays so.
      const [first, second] = [b, c].sort((x, y) => x.session.doc.clientID - y.session.doc.clientID)
      const heldIn = (holds: Holds) => heldValue(holds, target)
      yield* until(() =>
        Equal.equals(heldIn(registry.get(a.session.heldElsewhere)), heldIn(registry.get(first.session.holds)))
      )
      yield* settled
      pages.forEach(({ session }, i) =>
        expect(registry.get(session.held(target))).toEqual(Option.some([0.2, 0.6, 0.9][i]))
      )
      expect(registry.get(a.session.heldElsewhere)).toEqual(registry.get(first.session.holds))
      expect(registry.get(a.session.heldElsewhere)).not.toEqual(registry.get(second.session.holds))
    })
  ))

test("Sync off lets go of the other tabs' holds, and they of its own; Sync on tells them again", () =>
  run(
    Effect.gen(function* () {
      const registry = yield* AtomRegistry.AtomRegistry
      const name = yield* freshName
      const here = newProject()
      const there = loaded(here)
      const a = yield* pageOf(name, here)
      const b = yield* pageOf(name, there)
      const target = kickVolume(here)
      registry.set(a.session.holds, holding(noHolds, target, 0.2))
      registry.set(b.session.holds, holding(noHolds, HoldTarget.Tempo(), 140))
      yield* until(() => registry.get(a.session.heldElsewhere).length === 1)
      yield* until(() => registry.get(b.session.heldElsewhere).length === 1)
      yield* b.tabs.toggle
      expect(registry.get(b.session.heldElsewhere)).toEqual(noHolds)
      yield* until(() => registry.get(a.session.heldElsewhere).length === 0)
      yield* b.tabs.toggle
      yield* until(
        () => registry.get(a.session.heldElsewhere).length === 1 && registry.get(b.session.heldElsewhere).length === 1
      )
    })
  ))

test('a page hidden holds nothing for the others, who let go of its holds at once, and stays in step; shown, it tells them again', () =>
  run(
    Effect.gen(function* () {
      const registry = yield* AtomRegistry.AtomRegistry
      const name = yield* freshName
      const here = newProject()
      const there = loaded(here)
      const a = yield* pageOf(name, here)
      const b = yield* pageOf(name, there)
      registry.set(b.session.holds, holding(noHolds, kickVolume(there), 0.2))
      yield* until(() => registry.get(a.session.heldElsewhere).length === 1)
      b.page.dispatchEvent(new Event('pagehide'))
      yield* until(() => registry.get(a.session.heldElsewhere).length === 0)
      setTempo(here, by, 150)
      registry.set(b.session.holds, holding(noHolds, kickVolume(there), 0.3))
      yield* until(() => tempoOf(there) === 150)
      yield* settled
      expect(registry.get(a.session.heldElsewhere)).toEqual(noHolds)
      b.page.dispatchEvent(new Event('pageshow'))
      yield* until(() => registry.get(a.session.heldElsewhere).length === 1)
      expect(registry.get(a.session.held(kickVolume(here)))).toEqual(Option.some(0.3))
    })
  ))

/** A message that tells the presence of each client in `entries`, then breaks off if `broken`. */
const presenceOf = (
  entries: ReadonlyArray<readonly [client: number, clock: number, state: unknown]>,
  broken = false
) => {
  const message = encoding.createEncoder()
  encoding.writeVarUint(message, presenceMessage)
  const update = encoding.createEncoder()
  // Broken: one entry more than it holds, cut short after its client.
  const cutShort = Boolean.match(broken, { onTrue: () => [1], onFalse: () => [] })
  encoding.writeVarUint(update, entries.length + cutShort.length)
  entries.forEach(([client, clock, state]) => {
    encoding.writeVarUint(update, client)
    encoding.writeVarUint(update, clock)
    encoding.writeVarString(update, JSON.stringify(state))
  })
  cutShort.forEach((client) => encoding.writeVarUint(update, client))
  encoding.writeVarUint8Array(message, encoding.toUint8Array(update))
  return encoding.toUint8Array(message)
}

test('a tab another tells gone says it is still here, and the others keep its holds', () =>
  run(
    Effect.gen(function* () {
      const registry = yield* AtomRegistry.AtomRegistry
      const name = yield* freshName
      const here = newProject()
      const there = loaded(here)
      const a = yield* pageOf(name, here)
      const b = yield* pageOf(name, there)
      registry.set(a.session.holds, holding(noHolds, kickVolume(here), 0.2))
      yield* until(() => registry.get(b.session.heldElsewhere).length === 1)
      const { channel: stranger } = yield* listening(name, here)
      stranger.postMessage(presenceOf([[here.clientID, 1_000_000, null]]))
      yield* settled
      expect(registry.get(b.session.held(kickVolume(there)))).toEqual(Option.some(0.2))
    })
  ))

test('presence that breaks off midway keeps the holds it told before, and the tabs play them', () => {
  const logged: Array<Logger.Options<unknown>> = []
  return run(
    Effect.gen(function* () {
      const registry = yield* AtomRegistry.AtomRegistry
      const name = yield* freshName
      const here = newProject()
      const a = yield* pageOf(name, here)
      const { channel: stranger } = yield* listening(name, here)
      stranger.postMessage(presenceOf([[7, 1, { holds: [{ target: { _tag: 'Tempo' }, value: 140 }] }]], true))
      yield* until(() => registry.get(a.session.heldElsewhere).length === 1)
      expect(registry.get(a.session.held(HoldTarget.Tempo()))).toEqual(Option.some(140))
      expect(logged.flatMap(({ message }) => message)).toEqual([expect.any(TabMessageBroken)])
    }).pipe(Effect.provide(logInto(logged)))
  )
})

test("another tab's presence is read as anything: what isn't a hold is left out", () =>
  run(
    Effect.gen(function* () {
      const registry = yield* AtomRegistry.AtomRegistry
      const name = yield* freshName
      const here = newProject()
      const a = yield* pageOf(name, here)
      const { channel } = yield* listening(name, here)
      const stranger = yield* Effect.acquireRelease(
        Effect.sync(() => new Awareness(new Y.Doc())),
        (awareness) => Effect.sync(() => awareness.destroy())
      )
      stranger.setLocalState({
        holds: [
          { target: { _tag: 'Tempo' }, value: 'fast' },
          { target: { _tag: 'ChannelParam', channel: 'kick', param: 'feedback' }, value: 1 },
          { target: { _tag: 'Tempo' }, value: 140 }
        ]
      })
      const message = encoding.createEncoder()
      encoding.writeVarUint(message, presenceMessage)
      encoding.writeVarUint8Array(message, encodeAwarenessUpdate(stranger, [stranger.clientID]))
      channel.postMessage(encoding.toUint8Array(message))
      yield* until(() => registry.get(a.session.heldElsewhere).length > 0)
      expect(registry.get(a.session.heldElsewhere)).toEqual([
        { target: HoldTarget.Tempo(), value: 140 }
      ] satisfies Holds)
    })
  ))
