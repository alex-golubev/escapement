// @vitest-environment happy-dom
import { RegistryContext } from '@effect/atom-react'
import { EngineStartError, ProcessorError, type Telemetry } from '@escapement/engine'
import { MidiKey, type ParamId, paramPosition, paramValue, plugins, Sha256, Tick } from '@escapement/engine-description'
import {
  addClip,
  addNote,
  addTrack,
  type Auditions,
  barSteps,
  barTicks,
  createProject,
  defaultTrackStrip,
  deleteTrack,
  editorOf,
  eraseNotes,
  type Holds,
  HoldTarget,
  holding,
  moveClip,
  moveNote,
  newWriter,
  noHolds,
  patternEnd,
  readProject,
  readProjectId,
  renameTrack,
  resizeClip,
  setTrackStrip,
  stepTicks,
  stretchNote,
  trackStrip,
  trimClip
} from '@escapement/model'
import { Boolean, Cause, Duration, Effect, FiberSet, Option } from 'effect'
import { KeyValueStore } from 'effect/persistence'
import { Atom, AtomRegistry } from 'effect/reactivity'
import { options, render } from 'preact'
import { expect, test, vi } from 'vitest'
import * as Y from 'yjs'
import { registryOptions } from '../src/app/core'
import {
  BenchmarkState,
  type EngineHost,
  EngineState,
  type Frame,
  LoadState,
  type Restarts,
  type Transport
} from '../src/services/engine-host'
import { AudioThreadHung, BuildThreadHung } from '../src/services/hang-watch'
import { Page as PageEvents } from '../src/services/page'
import type { ProjectStorage } from '../src/services/project-store'
import { sessionOf } from '../src/services/session'
import type { TabSync } from '../src/services/tab-sync'
import { turnsOf } from '../src/services/turns'
import { viewStoreFor } from '../src/services/view-store'
import { type Core, CoreContext } from '../src/ui/core-context'
import { deskWindows } from '../src/ui/screens/project/desk'
import { App } from '../src/ui/screens/project/project'
import { type View, xOf, yOf } from '../src/ui/windows/piano-roll/geometry'
import { keysWidth, rowHeight, rulerHeight, stepWidth } from '../src/ui/windows/piano-roll/layout'
import {
  type View as ArrangementView,
  xOf as arrangementXOf,
  yOf as arrangementYOf
} from '../src/ui/windows/arrangement/geometry'
import {
  barWidth,
  headsWidth,
  rulerHeight as arrangementRulerHeight,
  trackHeight
} from '../src/ui/windows/arrangement/layout'
import { savedIn } from './saved-in'

// The debug panel shows it, and happy-dom has none.
Object.assign(globalThis, { crossOriginIsolated: false })

/** Another client. */
const elsewhere = newWriter('elsewhere')

/** The drums the test projects have a track of each, a sampler playing its sound. */
const drums = ['Kick', 'Snare'].map((name, i) => ({ name, sound: Sha256(`${i}c`.repeat(32)) }))

/** An engine that is ready and plays nothing; its frame is the test's to set. */
const quietHost = (frame: { current: Frame | undefined }): EngineHost => ({
  state: Atom.make(EngineState.Ready()),
  restarts: Atom.make<Restarts>({ count: 0, last: Option.none(), backInMs: Option.none() }),
  awake: Atom.make(false),
  transport: Atom.make<Transport>('stopped'),
  togglePlay: Effect.void,
  wake: Effect.void,
  restart: Effect.void,
  rebuild: Effect.void,
  sendBadCommand: Effect.void,
  storeBadSample: Effect.void,
  panicAudio: Effect.void,
  panicBuild: Effect.void,
  hangAudio: Effect.void,
  hangBuild: Effect.void,
  breakStream: Effect.void,
  samples: Atom.make([]),
  events: Atom.make([]),
  benchmark: Atom.make(BenchmarkState.Idle()),
  runBenchmark: Effect.void,
  load: Atom.make(LoadState.Idle()),
  runLoad: Effect.void,
  frame: () => frame.current
})

/** A page alone: no other tab is open. */
const aloneTabs: TabSync = { on: Atom.make(true), toggle: Effect.void }

interface Page {
  readonly doc: Y.Doc
  /** What this client holds now. */
  readonly holds: () => Holds
  /** The notes this client plays by hand now. */
  readonly auditions: () => Auditions
  /** What the project's other tabs hold, as their presence would tell. */
  readonly elsewhere: (holds: Holds) => void
  /** The page's own element. */
  readonly target: HTMLElement
  /** The tracks' heads, down the Arrangement's left. */
  readonly grid: HTMLElement
  readonly frame: { current: Frame | undefined }
  /** What the heads changed in the DOM while `act` ran and Preact drew after it, and the components it drew. */
  readonly changed: (
    act: () => void
  ) => Effect.Effect<{ readonly nodes: ReadonlyArray<Node>; readonly components: ReadonlyArray<string> }>
  /** The page's button by its label. */
  readonly button: (label: string) => HTMLButtonElement
  /** The components drawn while the page opened. */
  readonly opened: ReadonlyArray<string>
}

/** Past Preact's render and the frames due by then: a timer, after the immediates happy-dom runs frames on. */
const drawn = (ms = 1) => Effect.sleep(Duration.millis(ms))

/** Once `done` holds, as long as a slow machine takes, within about two seconds; past that the checks say what's amiss. */
const drawnWhen = (done: () => boolean) => Effect.repeat(drawn(5), { until: done, times: 400 })

/** A browser's store of views, kept in memory. */
const memoryViews = () =>
  Effect.runSync(Effect.provide(Effect.service(KeyValueStore.KeyValueStore), KeyValueStore.layerMemory))

/** A new project with a track for each drum, as another client makes it, and no clip. */
const tracksDoc = () => {
  const doc = new Y.Doc()
  createProject(doc, elsewhere)
  drums.forEach(({ name, sound }) =>
    Option.map(addTrack(doc, elsewhere, { plugin: plugins.sampler, sounds: { sample: sound } }), (track) =>
      renameTrack(doc, elsewhere, track, name)
    )
  )
  return doc
}

/** The drums' tracks and synths after them, `count` in all, and no clip: "Synth", then "Synth 2" and on. */
const manyTracksDoc = (count: number) => {
  const doc = tracksDoc()
  Array.from({ length: count - drums.length }).forEach(() => addTrack(doc, elsewhere))
  return doc
}

/** The name of the track at the place, from 0. */
const trackAt = (doc: Y.Doc, place: number) => readProject(doc).value.tracks[place]?.name

/** A project of the drums' tracks, the Kick's with a clip a bar long from the start. */
const projectDoc = () => {
  const doc = tracksDoc()
  Option.map(Option.fromUndefinedOr(readProject(doc).value.tracks[0]), ({ id }) =>
    addClip(doc, elsewhere, { track: id, tick: Tick(0) })
  )
  return doc
}

/** What the browser holds across pages: its store of views, and the project, if not a new one. */
interface Browser {
  readonly views?: KeyValueStore.KeyValueStore
  readonly doc?: Y.Doc
}

/**
 * The page on the browser's project, or a new one, while `use` runs, its engine as `host` says, its storage
 * `storage`.
 */
const page = (
  use: (page: Page) => Effect.Effect<void>,
  host: Partial<EngineHost> = {},
  storage: Partial<ProjectStorage> = {},
  { views = memoryViews(), doc = projectDoc() }: Browser = {}
) =>
  Effect.gen(function* () {
    const registry = yield* AtomRegistry.AtomRegistry
    // Bound to the page's scope; a click's failure shows, as on the page.
    const runFork = yield* FiberSet.makeRuntime()
    const frame: { current: Frame | undefined } = { current: undefined }
    const session = yield* sessionOf({ ...savedIn(doc), ...storage }, newWriter('page'))
    const ops = yield* editorOf(doc, session.writer)
    const view = yield* viewStoreFor(Option.some(views), doc, () => 'saved')
    const core: Core = {
      registry,
      session,
      ops,
      turns: yield* turnsOf(ops, session.holds),
      host: { ...quietHost(frame), ...host },
      tabs: aloneTabs,
      view,
      run: (effect) => void runFork(effect.pipe(Effect.tapCause(Effect.logError)))
    }
    /** The components Preact draws, by name, since the list was last started. */
    const drawnComponents: { list: Array<string> } = { list: [] }
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const diffed = options.diffed
        options.diffed = (vnode) => {
          Option.match(
            Option.liftPredicate(vnode.type, (type) => typeof type === 'function'),
            { onNone: () => {}, onSome: (component) => void drawnComponents.list.push(component.name) }
          )
          diffed?.(vnode)
        }
        return diffed
      }),
      (diffed) =>
        Effect.sync(() => {
          options.diffed = diffed
        })
    )
    const target = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const target = document.body.appendChild(document.createElement('div'))
        render(
          <RegistryContext.Provider value={registry}>
            <CoreContext.Provider value={core}>
              <App />
            </CoreContext.Provider>
          </RegistryContext.Provider>,
          target
        )
        return target
      }),
      (target) =>
        Effect.sync(() => {
          render(null, target)
          target.remove()
        })
    )
    // Open once the desk is drawn and the transport bar's buttons follow it; then a frame for the effects left.
    yield* drawnWhen(
      () =>
        target.querySelector('.track-heads') !== null &&
        target.querySelector('.btn--window[aria-pressed="true"]') !== null
    )
    yield* drawn(50)
    const opened = drawnComponents.list
    const grid = yield* Option.match(Option.fromNullishOr(target.querySelector<HTMLElement>('.track-heads')), {
      onNone: () => Effect.die('No heads'),
      onSome: Effect.succeed
    })
    yield* use({
      doc,
      holds: () => registry.get(session.holds),
      auditions: () => registry.get(session.auditions),
      elsewhere: (holds) => registry.set(session.heldElsewhere, holds),
      target,
      grid,
      frame,
      changed: (act) =>
        Effect.gen(function* () {
          const nodes = new Set<Node>()
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              const observer = new MutationObserver((records) => records.forEach(({ target }) => nodes.add(target)))
              observer.observe(grid, { subtree: true, attributes: true, childList: true, characterData: true })
              return observer
            }),
            (observer) => Effect.sync(() => observer.disconnect())
          )
          drawnComponents.list = []
          act()
          yield* drawn()
          return { nodes: [...nodes], components: drawnComponents.list }
        }).pipe(Effect.scoped),
      opened,
      button: (label) =>
        Option.getOrThrowWith(
          Option.fromNullishOr(target.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)),
          () => new Error(`No button ${label}`)
        )
    })
  }).pipe(
    Effect.scoped,
    Effect.provideService(AtomRegistry.AtomRegistry, AtomRegistry.make(registryOptions)),
    // The page's window: the layout written as it goes.
    Effect.provideService(PageEvents, window),
    Effect.runPromise
  )

const pressed = (button: HTMLButtonElement) => button.getAttribute('aria-pressed') === 'true'

/** A window's button on the transport bar pressed, once the dock has drawn what it did. */
const pressWindowButton = (target: HTMLElement, title: string) =>
  Effect.sync(() => windowButton(target, title).click()).pipe(Effect.andThen(drawn(50)))

test("the page draws each track's head once as it opens", () =>
  page(({ opened }) =>
    Effect.sync(() => {
      expect(opened.filter((name) => name === 'TrackHead')).toHaveLength(drums.length)
    })
  ))

/** One restart, for `last`. */
const restartedFor = (last: Restarts['last'], backInMs = Option.none<number>()) =>
  Atom.make<Restarts>({ count: 1, last, backInMs })

test.each<[string, Partial<EngineHost>]>([
  [
    'engine: failed: EngineStartError: Error: No shared memory',
    {
      state: Atom.make(
        EngineState.Failed({
          cause: Cause.fail(new EngineStartError({ cause: new Error('No shared memory') })),
          gaveUp: 'start'
        })
      )
    }
  ],
  [
    'engine: failed: EngineStartError: BuildThreadHung: The build thread did not answer its start',
    {
      state: Atom.make(
        EngineState.Failed({
          cause: Cause.fail(
            new EngineStartError({
              cause: new BuildThreadHung({ message: 'The build thread did not answer its start' })
            })
          ),
          gaveUp: 'start'
        })
      )
    }
  ],
  [
    'engine: hung: AudioThreadHung: The audio thread stopped answering',
    {
      state: Atom.make(
        EngineState.Hung({ error: new AudioThreadHung({ message: 'The audio thread stopped answering' }) })
      )
    }
  ],
  [
    'restarts: 1 (last: ProcessorError: Uncaught Error: panicked at lib.rs:1:1: PanicAudio 1) · back in 72 ms',
    {
      restarts: restartedFor(
        Option.some(
          Cause.fail(new ProcessorError({ message: 'Uncaught Error: panicked at lib.rs:1:1: PanicAudio 1' }))
        ),
        Option.some(72.4)
      )
    }
  ],
  ['restarts: 1 (last: Error: A bug)', { restarts: restartedFor(Option.some(Cause.die(new Error('A bug')))) }],
  ['Load failed: The engine sleeps until Play', { load: Atom.make(LoadState.Asleep()) }],
  ['Load failed: No filter on the master', { load: Atom.make(LoadState.NoFilter()) }],
  ['Load failed: Error: A bug', { load: Atom.make(LoadState.Failed({ cause: Cause.die(new Error('A bug')) })) }],
  [
    'Benchmark failed: TimeoutError',
    { benchmark: Atom.make(BenchmarkState.Failed({ cause: Cause.fail(new Cause.TimeoutError()) })) }
  ]
])('the debug panel says "%s"', (said, host) =>
  page(
    ({ target }) =>
      Effect.gen(function* () {
        yield* pressWindowButton(target, 'Debug')
        expect(target.textContent).toContain(said)
      }),
    host
  )
)

test.each<[Transport, boolean, boolean, string]>([
  ['stopped', false, false, 'Play: only for you, each tab listens on its own'],
  ['starting', false, true, 'Play waits while the sound starts'],
  ['playing', true, false, 'Stop: only for you; the other tabs play on']
])('%s, Play is pressed: %s, disabled: %s, and says "%s"', (transport, lit, disabled, hint) =>
  page(
    ({ button }) =>
      Effect.sync(() => {
        const play = button('Play')
        expect(pressed(play)).toBe(lit)
        expect(play.disabled).toBe(disabled)
        expect(play.dataset.hint).toBe(hint)
      }),
    { transport: Atom.make(transport) }
  )
)

test("Play the sound stopped for can't be pressed, and says why; undo with nothing to undo says so", () =>
  page(
    ({ button }) =>
      Effect.sync(() => {
        expect(button('Play').disabled).toBe(true)
        expect(button('Play').dataset.hint).toBe('Play: the sound is stopped, as the status on the right says')
        expect(button('Undo').dataset.hint).toBe('Nothing of yours to undo now')
      }),
    { state: Atom.make(EngineState.Hung({ error: new AudioThreadHung({ message: 'Silent' }) })) }
  ))

const bug = Cause.die(new Error('A bug'))

/** What the transport bar says is wrong. */
const status = (target: HTMLElement) => target.querySelector('[role="status"]')?.textContent

test.each<[string, Partial<EngineHost>, Partial<ProjectStorage>]>([
  ['', {}, {}],
  ['Starting the sound…', { state: Atom.make(EngineState.Starting({ afterFailure: false })) }, {}],
  ['Starting the sound…', { transport: Atom.make<Transport>('starting') }, {}],
  [
    'Sound is restarting…',
    // Whatever the count says: a restart asked for after a failure isn't one.
    { state: Atom.make(EngineState.Starting({ afterFailure: true })) },
    {}
  ],
  [
    'Starting the sound…',
    { state: Atom.make(EngineState.Starting({ afterFailure: false })), restarts: restartedFor(Option.none()) },
    {}
  ],
  ["Sound didn't load — reload the page", { state: Atom.make(EngineState.Failed({ cause: bug, gaveUp: 'load' })) }, {}],
  ["Sound can't start here", { state: Atom.make(EngineState.Failed({ cause: bug, gaveUp: 'start' })) }, {}],
  ['Sound stopped — reload the page', { state: Atom.make(EngineState.Failed({ cause: bug, gaveUp: 'often' })) }, {}],
  ['Sound hung', { state: Atom.make(EngineState.Hung({ error: new AudioThreadHung({ message: 'Silent' }) })) }, {}],
  ["Not saved: the project didn't load", {}, { loaded: 'not-loaded' }],
  ['Not saved: the project is missing', {}, { loaded: 'missing' }],
  ['Not saved: the project was deleted', {}, { stopped: Effect.succeed('erased-elsewhere') }],
  ['Not saved: the browser is out of space', {}, { stopped: Effect.succeed('out-of-space') }],
  [
    'Sound stopped — reload the pageNot saved: the browser refused',
    { state: Atom.make(EngineState.Failed({ cause: bug, gaveUp: 'often' })) },
    { stopped: Effect.succeed('refused') }
  ]
])('the status reads "%s"', (said, host, storage) =>
  page(
    ({ target }) =>
      Effect.sync(() => {
        expect(status(target)).toBe(said)
      }),
    host,
    storage
  )
)

test('+ adds a track with a synth under the others, its pan and volume in its head; Cmd+Z takes it back', () =>
  page(({ doc, target, button }) =>
    Effect.gen(function* () {
      const heads = () => Array.from(target.querySelectorAll('.track-head__name'), (name) => name.textContent)
      const before = heads()
      button('Add a track').click()
      button('Add a track').click()
      yield* drawn()
      expect(heads()).toEqual([...before, 'Synth', 'Synth 2'])
      expect(readProject(doc).value.tracks.at(-1)?.name).toBe('Synth 2')
      expect(
        button('Synth 2: mute').closest('.track-head')?.querySelector('[aria-label="Synth 2: volume"]')
      ).not.toBeNull()
      press(document.body, { key: 'z', metaKey: true })
      yield* drawn()
      expect(heads()).toEqual([...before, 'Synth'])
    })
  ))

/** The items of the menu open now, by label. */
const menuItems = () =>
  new Map(
    Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'), (item) => [item.textContent, item])
  )

/** The menu of the track's name, opened by a right click on it. */
const trackMenu = (target: HTMLElement, name: string) =>
  Effect.sync(() =>
    Array.from(target.querySelectorAll('.track-head__name'))
      .find((button) => button.textContent === name)
      ?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  ).pipe(Effect.andThen(drawn()), Effect.map(menuItems))

/**
 * happy-dom has no popovers: while `use` runs, one opens as the browser's does, and closes, the one way the page toggles
 * it, telling so.
 */
const withPopovers = <A,>(use: () => Promise<A>): Promise<A> => {
  const popover = HTMLElement.prototype as unknown as Record<string, unknown>
  popover.showPopover = function (this: HTMLElement) {
    this.dataset.open = ''
  }
  popover.togglePopover = function (this: HTMLElement) {
    delete this.dataset.open
    this.dispatchEvent(Object.assign(new Event('toggle'), { newState: 'closed' }))
  }
  return use().finally(() => {
    delete popover.showPopover
    delete popover.togglePopover
  })
}

test("F2 on a track's name renames it in place, and so does its menu: Enter keeps the name and gives the focus back, Esc leaves it be; its menu deletes it, its clips with it, and Cmd+Z brings both back", () =>
  withPopovers(() =>
    page(({ doc, grid, target }) =>
      Effect.gen(function* () {
        const field = () => target.querySelector<HTMLInputElement>('[aria-label="Name of track 1"]')
        const names = () => readProject(doc).value.tracks.map(({ name }) => name)
        const typed = (name: string, key: string) =>
          Effect.gen(function* () {
            Option.map(Option.fromNullishOr(field()), (input) => {
              input.value = name
              press(input, { key })
            })
            yield* drawn()
          })
        expect(press(nameButton(grid, 'Kick'), { key: 'F2' })).toBe(false)
        yield* drawn()
        expect(document.activeElement).toBe(field())
        yield* typed('  Big kick ', 'Enter')
        expect(field()).toBeNull()
        expect(names()).toEqual(['Big kick', 'Snare'])
        expect(document.activeElement).toBe(nameButton(grid, 'Big kick'))
        press(nameButton(grid, 'Big kick'), { key: 'F2' })
        yield* drawn()
        yield* typed('Other', 'Escape')
        expect(names()).toEqual(['Big kick', 'Snare'])
        const menu = yield* trackMenu(target, 'Big kick')
        expect(Array.from(menu.keys())).toEqual(['Rename', 'Delete'])
        menu.get('Rename')?.click()
        yield* drawn()
        expect(field()?.value).toBe('Big kick')
        // Another client names it meanwhile: the name the field opened with, kept as it was, isn't written back.
        renameTrack(doc, elsewhere, readProject(doc).value.tracks[0].id, 'Theirs')
        Option.map(Option.fromNullishOr(field()), (input) => press(input, { key: 'Enter' }))
        yield* drawn()
        expect(names()).toEqual(['Theirs', 'Snare'])
        ;(yield* trackMenu(target, 'Theirs')).get('Delete')?.click()
        yield* drawn()
        expect(names()).toEqual(['Snare'])
        expect(readProject(doc).value.clips).toEqual([])
        press(document.body, { key: 'z', metaKey: true })
        yield* drawn()
        expect(names()).toEqual(['Theirs', 'Snare'])
        expect(clipsOf(doc)).toEqual([{ track: 'Theirs', bar: 0 }])
      })
    )
  ))

test('M writes the mute and fades the head; S solos for this client only and writes nothing', () =>
  page(({ doc, button, changed }) =>
    Effect.gen(function* () {
      const updates = { count: 0 }
      doc.on('update', () => {
        updates.count += 1
      })
      const unheard = (name: string) =>
        button(`${name}: mute`).closest('.track-head')?.getAttribute('data-unheard') === 'true'
      button('Kick: mute').click()
      yield* drawn()
      expect(readProject(doc).value.tracks[0].mute).toBe(true)
      expect(pressed(button('Kick: mute'))).toBe(true)
      expect(unheard('Kick')).toBe(true)
      expect(updates.count).toBe(1)
      const { components } = yield* changed(() => button('Snare: solo').click())
      expect(components).toContain('TrackHead')
      expect(pressed(button('Snare: solo'))).toBe(true)
      expect(unheard('Kick')).toBe(true)
      expect(updates.count).toBe(1)
      // Solo hears a track muted in the document too.
      button('Kick: solo').click()
      yield* drawn()
      expect(unheard('Kick')).toBe(false)
      expect(updates.count).toBe(1)
    })
  ))

test("a note dragged past the bar in the piano roll grows its clip's pattern to its bar, and takes back to the bar", () =>
  page(({ doc, target, button }) =>
    Effect.gen(function* () {
      noteElsewhere(doc, 'Kick', 0, 60)
      yield* openKickClip(target)
      const { drag } = yield* rollIn(target)
      drag([0, 60], [9, 60], [17, 60])
      yield* drawn()
      expect(notesByName(doc)).toEqual([{ track: 'Kick', tick: 17 * stepTicks, key: 60, length: stepTicks }])
      expect(kickClipBars(doc)).toBe(2)
      button('Undo').click()
      yield* drawn()
      expect(kickClipBars(doc)).toBe(1)
      expect(notesByName(doc)).toEqual([{ track: 'Kick', tick: 0, key: 60, length: stepTicks }])
    })
  ))

/** The page's button that reads `text` among those `selector` finds, such as one of the debug panel's. */
const textButton = (target: HTMLElement, text: string, selector = 'button') =>
  Option.getOrThrow(
    Option.fromNullishOr(
      Array.from(target.querySelectorAll<HTMLButtonElement>(selector)).find((button) => button.textContent === text)
    )
  )

/** The transport bar's button of the window called `title`. */
const windowButton = (target: HTMLElement, title: string) => textButton(target, title, '.btn--window')

/** The primary button, held down from press to release unless `buttons` says otherwise. */
const pointer = (
  target: Element,
  type: string,
  clientY: number,
  {
    shiftKey = false,
    pointerId = 1,
    buttons = Boolean.match(type === 'pointerup', { onTrue: () => 0, onFalse: () => 1 })
  } = {}
  // As the browser's: a press can be kept from what it would do by default.
) =>
  target.dispatchEvent(
    new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, buttons, pointerId, clientY, shiftKey })
  )

const key = (target: Element, key: string) => {
  target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key }))
}

const keyUp = (target: Element) => target.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'ArrowUp' }))

/** The Kick's own volume, which its head and its window turn. */
const kickVolume = (doc: Y.Doc) => readProject(doc).value.tracks[0].strip.volume

/** The button of the track's name in its head. */
const nameButton = (grid: HTMLElement, name: string) =>
  Option.getOrThrow(
    Option.fromNullishOr(
      Array.from(grid.querySelectorAll<HTMLButtonElement>('.track-head__name')).find(
        (button) => button.textContent === name
      )
    )
  )

/** The window of the track with this name. */
const trackWindow = (target: HTMLElement, name: string) =>
  Option.fromNullishOr(target.querySelector<HTMLElement>(`section[aria-label="${name}"]`))

/** The Kick's volume in its window: a knob with its name and number, which a drag on the number turns too. */
const kickKnob = (target: HTMLElement) =>
  Option.getOrThrow(
    Option.flatMapNullishOr(trackWindow(target, 'Kick'), (window) =>
      window.querySelector('[role="slider"][aria-label="Volume"]')
    )
  )

const trackVolume = Option.getOrThrow(Option.fromNullishOr(trackStrip.find(({ id }) => id === 'volume')))

/** A track's volume with its knob this far up. */
const at = (position: number) => paramValue(trackVolume, position)

/** How far up the Kick's volume knob stands: in the document, and as the knob shows it. */
const kickAt = (doc: Y.Doc) => paramPosition(trackVolume, kickVolume(doc))
const knobAt = (knob: Element) => paramPosition(trackVolume, Number(knob.getAttribute('aria-valuenow')))

/**
 * The page on a new project with each track's volume knob at 80%, room to turn it either way, and the Kick's window open
 * from its name.
 */
const knobPage = (use: (page: Page) => Effect.Effect<void>) => {
  const doc = projectDoc()
  readProject(doc).value.tracks.forEach(({ id }) => setTrackStrip(doc, elsewhere, id, 'volume', at(0.8)))
  return page(
    (opened) =>
      Effect.gen(function* () {
        nameButton(opened.grid, 'Kick').click()
        yield* drawn(50)
        yield* use(opened)
      }),
    {},
    {},
    { doc }
  )
}

/** How many transactions the document takes from now on. */
const counted = (doc: Y.Doc) => {
  const updates = { count: 0 }
  doc.on('update', () => {
    updates.count += 1
  })
  return updates
}

test('a knob turns as it is dragged, redrawing only itself, and writes the document when let go', () =>
  knobPage(({ doc, changed, target }) =>
    Effect.gen(function* () {
      const knob = kickKnob(target)
      // 200 pixels the whole way.
      pointer(knob, 'pointerdown', 100)
      // The press focuses the knob: its window comes forward.
      yield* drawn()
      const { components } = yield* changed(() => pointer(knob, 'pointermove', 80))
      // The same volume in its row, and the hint line, which tells the value of the knob with the focus.
      expect(components).toEqual(['Dial', 'Knob', 'Dial', 'SmallKnob', 'HintLine'])
      expect(knobAt(knob)).toBeCloseTo(0.9, 9)
      expect(kickAt(doc)).toBeCloseTo(0.8, 9)
      // With Shift, a tenth as far.
      pointer(knob, 'pointermove', 60, { shiftKey: true })
      yield* drawn()
      expect(knobAt(knob)).toBeCloseTo(0.91, 9)
      pointer(knob, 'pointerup', 60)
      yield* drawn()
      expect(kickAt(doc)).toBeCloseTo(0.91, 9)
      expect(Number(knob.getAttribute('aria-valuenow'))).toBe(kickVolume(doc))
    })
  ))

test("a knob another tab turns shows its value as it turns, redrawing only itself; turned here, this page's own", () =>
  knobPage(({ doc, changed, elsewhere, target }) =>
    Effect.gen(function* () {
      const knob = kickKnob(target)
      const volume = HoldTarget.TrackStrip({ track: readProject(doc).value.tracks[0].id, param: 'volume' })
      const { components } = yield* changed(() => elsewhere(holding(noHolds, volume, at(0.3))))
      // In its window and in its row.
      expect(components).toEqual(['Dial', 'Knob', 'Dial', 'SmallKnob'])
      expect(knobAt(knob)).toBeCloseTo(0.3, 9)
      expect(kickAt(doc)).toBeCloseTo(0.8, 9)
      // Turned here from what it shows, by this page's hand over the other's.
      pointer(knob, 'pointerdown', 100)
      pointer(knob, 'pointermove', 80)
      yield* drawn()
      expect(knobAt(knob)).toBeCloseTo(0.4, 9)
      pointer(knob, 'pointerup', 80)
      yield* drawn()
      expect(kickAt(doc)).toBeCloseTo(0.4, 9)
      elsewhere(holding(noHolds, volume, at(0.6)))
      yield* drawn()
      expect(knobAt(knob)).toBeCloseTo(0.6, 9)
      elsewhere(noHolds)
      yield* drawn()
      expect(knobAt(knob)).toBeCloseTo(0.4, 9)
    })
  ))

test('a knob pressed while another tab turns it goes from where it plays at the first move; a value out of range shows at the end', () =>
  knobPage(({ doc, elsewhere, target }) =>
    Effect.gen(function* () {
      const knob = kickKnob(target)
      const volume = HoldTarget.TrackStrip({ track: readProject(doc).value.tracks[0].id, param: 'volume' })
      elsewhere(holding(noHolds, volume, at(0.3)))
      yield* drawn()
      pointer(knob, 'pointerdown', 100)
      // The other tab turns on while this one holds still.
      elsewhere(holding(noHolds, volume, at(0.6)))
      yield* drawn()
      expect(knobAt(knob)).toBeCloseTo(0.6, 9)
      pointer(knob, 'pointermove', 98)
      yield* drawn()
      expect(knobAt(knob)).toBeCloseTo(0.61, 9)
      pointer(knob, 'pointermove', 96)
      yield* drawn()
      expect(knobAt(knob)).toBeCloseTo(0.62, 9)
      pointer(knob, 'pointerup', 96)
      yield* drawn()
      expect(kickAt(doc)).toBeCloseTo(0.62, 9)
      elsewhere(holding(noHolds, volume, 999))
      yield* drawn()
      expect(knob.getAttribute('aria-valuenow')).toBe('1')
      elsewhere(holding(noHolds, volume, -5))
      yield* drawn()
      expect(knob.getAttribute('aria-valuenow')).toBe('0')
    })
  ))

test('a drag past the end turns back at once, and a second pointer on the knob is left out', () =>
  knobPage(({ doc, target }) =>
    Effect.gen(function* () {
      const knob = kickKnob(target)
      pointer(knob, 'pointerdown', 300)
      pointer(knob, 'pointerdown', 300, { pointerId: 2 })
      pointer(knob, 'pointermove', 0)
      pointer(knob, 'pointermove', 500, { pointerId: 2 })
      yield* drawn()
      expect(knob.getAttribute('aria-valuenow')).toBe('1')
      pointer(knob, 'pointermove', 20)
      yield* drawn()
      expect(knobAt(knob)).toBeCloseTo(0.9, 9)
      pointer(knob, 'pointerup', 20, { pointerId: 2 })
      pointer(knob, 'pointermove', 40)
      pointer(knob, 'pointerup', 40)
      expect(kickAt(doc)).toBeCloseTo(0.8, 9)
    })
  ))

test('moves that add up to the bottom land on it: silence, not a rounding error above it', () =>
  knobPage(({ doc, target }) =>
    Effect.gen(function* () {
      const knob = kickKnob(target)
      // From 80%, ten moves of 16 pixels each: added up in floating point, a hair above 0.
      pointer(knob, 'pointerdown', 0)
      Array.from({ length: 10 }, (_, i) => pointer(knob, 'pointermove', (i + 1) * 16))
      pointer(knob, 'pointerup', 160)
      yield* drawn()
      expect(kickVolume(doc)).toBe(0)
      expect(knob.getAttribute('aria-valuetext')).toBe('−∞ dB')
    })
  ))

test('a drag whose release the page never heard ends at the next move without a button down', () =>
  knobPage(({ doc, holds, target }) =>
    Effect.gen(function* () {
      const knob = kickKnob(target)
      pointer(knob, 'pointerdown', 100)
      pointer(knob, 'pointermove', 80)
      pointer(knob, 'pointermove', 60, { buttons: 0 })
      expect(kickAt(doc)).toBeCloseTo(0.9, 9)
      expect(holds()).toEqual([])
      pointer(knob, 'pointermove', 40)
      expect(kickAt(doc)).toBeCloseTo(0.9, 9)
    })
  ))

test('a press that never moves writes nothing, and what another client wrote meanwhile stays', () =>
  knobPage(({ doc, holds, target }) =>
    Effect.gen(function* () {
      const knob = kickKnob(target)
      pointer(knob, 'pointerdown', 100)
      setTrackStrip(doc, elsewhere, readProject(doc).value.tracks[0].id, 'volume', 0.3)
      pointer(knob, 'pointerup', 100)
      expect(kickVolume(doc)).toBe(0.3)
      expect(holds()).toEqual([])
    })
  ))

test('a move sideways is no turn: a value the knob would read back changed is left as it is', () =>
  knobPage(({ doc, holds, target }) =>
    Effect.gen(function* () {
      const knob = kickKnob(target)
      setTrackStrip(doc, elsewhere, readProject(doc).value.tracks[0].id, 'volume', 0.85)
      yield* drawn()
      const updates = counted(doc)
      pointer(knob, 'pointerdown', 100)
      pointer(knob, 'pointermove', 100)
      expect(holds()).toEqual([])
      pointer(knob, 'pointerup', 100)
      expect(updates.count).toBe(0)
      expect(kickVolume(doc)).toBe(0.85)
    })
  ))

test('a knob that goes mid-turn, its track deleted elsewhere, lets go', () =>
  knobPage(({ doc, holds, target }) =>
    Effect.gen(function* () {
      const knob = kickKnob(target)
      pointer(knob, 'pointerdown', 100)
      pointer(knob, 'pointermove', 80)
      expect(holds()).toHaveLength(1)
      doc.transact(() => doc.getMap('tracks').delete(readProject(doc).value.tracks[0].id))
      // Preact cleans up after a frame.
      yield* drawn(50)
      expect(knob.isConnected).toBe(false)
      expect(holds()).toEqual([])
    })
  ))

test('keys turn a knob, a key held down as one turn written once, and a double click puts it back', () =>
  knobPage(({ doc, target }) =>
    Effect.gen(function* () {
      const knob = kickKnob(target)
      const updates = counted(doc)
      key(knob, 'ArrowUp')
      key(knob, 'ArrowUp')
      key(knob, 'ArrowUp')
      yield* drawn()
      expect(knobAt(knob)).toBeCloseTo(0.83, 9)
      expect(updates.count).toBe(0)
      keyUp(knob)
      expect(kickAt(doc)).toBeCloseTo(0.83, 9)
      expect(updates.count).toBe(1)
      key(knob, 'PageDown')
      keyUp(knob)
      expect(kickAt(doc)).toBeCloseTo(0.73, 9)
      key(knob, 'End')
      keyUp(knob)
      expect(kickVolume(doc)).toBe(1)
      key(knob, 'Home')
      keyUp(knob)
      expect(kickVolume(doc)).toBe(0)
      knob.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      expect(kickVolume(doc)).toBe(trackVolume.default)
    })
  ))

test("pan and volume stand before a track's name in its head, turn its strip and are put back by Cmd+Z", () =>
  page(({ doc, grid }) =>
    Effect.gen(function* () {
      const knob = (label: string) =>
        Option.getOrThrow(Option.fromNullishOr(grid.querySelector(`[role="slider"][aria-label="${label}"]`)))
      const [pan, volume] = [knob('Kick: pan'), knob('Kick: volume')]
      const kickStrip = () => readProject(doc).value.tracks[0].strip
      const head = pan.closest('.track-head')
      expect(Array.from(head?.children ?? [], (child) => child.className)).toEqual([
        'track-head__strip',
        'track-head__name',
        'track-head__buttons'
      ])
      // The instrument's knobs are in the track's window, and its mixer strip too.
      expect(head?.querySelectorAll('[role="slider"]')).toHaveLength(2)
      expect(head?.querySelector('[role="spinbutton"]')).toBeNull()
      // A new track's volume, 5.2 dB down.
      expect(volume.getAttribute('aria-valuetext')).toBe('−5.2 dB')
      // Pan fills from the middle, where its zero stands.
      expect(pan.getAttribute('aria-valuetext')).toBe('center')
      expect((pan as HTMLElement).style.getPropertyValue('--zero')).toBe('0.5')
      expect((volume as HTMLElement).style.getPropertyValue('--zero')).toBe('0')
      // From -1 to 1 over 200 pixels.
      pointer(pan, 'pointerdown', 100)
      pointer(pan, 'pointermove', 80)
      yield* drawn()
      expect(pan.getAttribute('aria-valuetext')).toBe('20% right')
      expect(kickStrip().pan).toBe(0)
      pointer(pan, 'pointerup', 80)
      yield* drawn()
      expect(kickStrip().volume).toBe(defaultTrackStrip.volume)
      expect(kickStrip().pan).toBeCloseTo(0.2)
      key(volume, 'Home')
      keyUp(volume)
      yield* drawn()
      expect(kickStrip().volume).toBe(0)
      expect(volume.getAttribute('aria-valuetext')).toBe('−∞ dB')
      expect(kickStrip().pan).toBeCloseTo(0.2)
      // Back to a track's default, not to the engine's.
      volume.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      yield* drawn()
      expect(volume.getAttribute('aria-valuetext')).toBe('−5.2 dB')
      press(document.body, { key: 'z', metaKey: true })
      yield* drawn()
      expect(kickStrip().volume).toBe(0)
      press(document.body, { key: 'z', metaKey: true })
      yield* drawn()
      expect(kickStrip().volume).toBe(defaultTrackStrip.volume)
      expect(kickStrip().pan).toBeCloseTo(0.2)
      press(document.body, { key: 'z', metaKey: true })
      yield* drawn()
      expect(kickStrip()).toEqual(defaultTrackStrip)
      expect(pan.getAttribute('aria-valuetext')).toBe('center')
    })
  ))

/** The mixer strip the Kick goes into. */
const kickInsert = (doc: Y.Doc) => readProject(doc).value.tracks[0].insert

test("a track's mixer strip, in its window, is dragged, typed and kept with Enter or a click elsewhere, the master on a double click", () =>
  page(({ doc, grid, target }) =>
    Effect.gen(function* () {
      nameButton(grid, 'Kick').click()
      yield* drawn(50)
      const field = Option.getOrThrow(
        Option.fromNullishOr(target.querySelector<HTMLElement>('[role="spinbutton"][aria-label="Kick: mixer strip"]'))
      )
      expect(field.textContent).toBe('—')
      expect(field.getAttribute('aria-valuetext')).toBe('the master')
      // 4 pixels a strip: held while dragged, written once let go.
      pointer(field, 'pointerdown', 100)
      pointer(field, 'pointermove', 92)
      yield* drawn()
      expect(field.textContent).toBe('2')
      expect(kickInsert(doc)).toBe('master')
      pointer(field, 'pointerup', 92)
      yield* drawn()
      expect(kickInsert(doc)).toBe('2')
      expect(field.getAttribute('aria-valuetext')).toBe('strip 2')
      key(field, '1')
      key(field, '2')
      yield* drawn()
      expect(field.textContent).toBe('12')
      expect(field.dataset.typing).toBe('true')
      expect(kickInsert(doc)).toBe('2')
      key(field, 'Enter')
      yield* drawn()
      expect(kickInsert(doc)).toBe('12')
      expect(field.dataset.typing).toBe('false')
      // Esc leaves it as it was; a number past the last strip is refused, a digit too many with it, not cut off.
      key(field, '9')
      key(field, 'Escape')
      yield* drawn()
      expect(field.textContent).toBe('12')
      ;['7', '7', '7', 'Enter'].forEach((typed) => key(field, typed))
      ;['1', '2', '3', '4', '5'].forEach((typed) => key(field, typed))
      yield* drawn()
      expect(field.textContent).toBe('1234')
      key(field, 'Enter')
      yield* drawn()
      expect(kickInsert(doc)).toBe('12')
      // While a number is typed, the arrows don't turn it and Cmd+Z undoes nothing; a shortcut with a digit isn't typed.
      key(field, '5')
      // Drawn, as between two keys a person presses.
      yield* drawn()
      key(field, 'ArrowUp')
      press(field, { key: 'z', metaKey: true })
      press(field, { key: '1', metaKey: true })
      yield* drawn()
      expect(field.textContent).toBe('5')
      expect(field.getAttribute('aria-valuetext')).toBe('typing 5')
      expect(kickInsert(doc)).toBe('12')
      key(field, 'Escape')
      key(field, '3')
      key(field, 'Backspace')
      key(field, '4')
      field.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
      yield* drawn()
      expect(kickInsert(doc)).toBe('4')
      field.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      yield* drawn()
      expect(kickInsert(doc)).toBe('master')
      press(document.body, { key: 'z', metaKey: true })
      yield* drawn()
      expect(kickInsert(doc)).toBe('4')
      press(document.body, { key: 'z', metaKey: true })
      press(document.body, { key: 'z', metaKey: true })
      press(document.body, { key: 'z', metaKey: true })
      yield* drawn()
      expect(kickInsert(doc)).toBe('master')
    })
  ))

/** The insert of this number as the document has it; at its defaults if the document holds nothing of it. */
const insertIn = (doc: Y.Doc, id: string) =>
  Option.fromUndefinedOr(readProject(doc).value.inserts.find((insert) => insert.id === id))

test("the mixer's strips: a fader turns an insert's volume, M mutes it, and the master's fader turns its own", () =>
  page(({ doc, target }) =>
    Effect.gen(function* () {
      yield* pressWindowButton(target, 'Mixer')
      const fader = (label: string) =>
        Option.getOrThrow(Option.fromNullishOr(target.querySelector(`[role="slider"][aria-label="${label}"]`)))
      const first = fader('Strip 1: volume')
      expect(first.getAttribute('aria-valuetext')).toBe('0.0 dB')
      // Its travel, 146 pixels, from end to end.
      pointer(first, 'pointerdown', 200)
      pointer(first, 'pointermove', 346)
      yield* drawn()
      expect(first.getAttribute('aria-valuetext')).toBe('−∞ dB')
      expect(insertIn(doc, '1')).toEqual(Option.none())
      pointer(first, 'pointerup', 346)
      yield* drawn()
      expect(Option.map(insertIn(doc, '1'), ({ strip }) => strip.volume)).toEqual(Option.some(0))
      const mute = Option.getOrThrow(
        Option.fromNullishOr(target.querySelector<HTMLButtonElement>('button[aria-label="Strip 1: mute"]'))
      )
      mute.click()
      yield* drawn()
      expect(Option.map(insertIn(doc, '1'), ({ mute }) => mute)).toEqual(Option.some(true))
      expect(mute.closest('.strip')?.getAttribute('data-muted')).toBe('true')
      mute.click()
      yield* drawn()
      expect(Option.map(insertIn(doc, '1'), ({ mute }) => mute)).toEqual(Option.some(false))
      const master = fader('Master: volume')
      key(master, 'End')
      keyUp(master)
      yield* drawn()
      expect(master.getAttribute('aria-valuetext')).toBe('+5.6 dB')
      expect(readProject(doc).value.master.strip.volume).toBeCloseTo(1.905, 3)
    })
  ))

test("a strip's meters draw its record on the board, found by its number; its lamp latches, out of sight too", () =>
  page(({ target, frame }) =>
    Effect.gen(function* () {
      yield* pressWindowButton(target, 'Mixer')
      /** The strip's meters, by the lamp over the left one. */
      const stripOf = (output: string) =>
        Option.getOrThrow(
          Option.fromNullishOr(target.querySelector(`button[aria-label="${output}: clip, left"]`)?.closest('.strip'))
        )
      const levels = (output: string) =>
        Array.from(stripOf(output).querySelectorAll<HTMLElement>('.meter__fill'), (fill) =>
          fill.style.getPropertyValue('--level')
        )
      const lit = (output: string) =>
        Array.from(stripOf(output).querySelectorAll('.meter-clip'), (lamp) => lamp.getAttribute('data-lit'))
      const putOut = (output: string) =>
        Array.from(stripOf(output).querySelectorAll<HTMLButtonElement>('.meter-clip'), (lamp) => lamp.click())
      const seen = (telemetry: Telemetry | undefined) =>
        Effect.sync(() => {
          frame.current = { engine: 1, telemetry, heard: undefined, stats: undefined }
        }).pipe(Effect.andThen(drawn(50)))
      const shown = (meters: Telemetry['meters']) => seen(boardWith([0, 0], [0, 0], meters))
      const two = (overs: readonly [number, number], peaks: readonly [number, number] = [0.1, 0.5]) => ({
        meter: 2,
        peaks,
        overs
      })
      const one = { meter: 1, peaks: [1, 1], overs: [0, 0] } as const
      const rack = Option.getOrThrow(Option.fromNullishOr(target.querySelector<HTMLElement>('.rack')))
      const scrolledTo = (left: number) =>
        Effect.sync(() => {
          rack.scrollLeft = left
          rack.dispatchEvent(new Event('scroll'))
        }).pipe(Effect.andThen(drawn()))
      yield* shown([two([0, 4])])
      expect(levels('Strip 2 output')).toEqual(['0.667', '0.900'])
      expect(levels('Strip 1 output')).toEqual(['0.000', '0.000'])
      expect(levels('Master output')).toEqual(['0.000', '0.000'])
      // Second on the board now: still its own.
      yield* shown([one, two([0, 5], [0, 0.5])])
      expect(levels('Strip 2 output')).toEqual(['0.000', '0.900'])
      expect(levels('Strip 1 output')).toEqual(['1.000', '1.000'])
      expect(lit('Strip 2 output')).toEqual([null, 'true'])
      expect(lit('Strip 1 output')).toEqual([null, null])
      putOut('Strip 2 output')
      yield* drawn()
      expect(lit('Strip 2 output')).toEqual([null, null])
      // A board that couldn't be read leaves the meters as they were, and the count as it was seen.
      yield* seen(undefined)
      expect(levels('Strip 2 output')).toEqual(['0.000', '0.900'])
      yield* shown([two([0, 6])])
      expect(lit('Strip 2 output')).toEqual([null, 'true'])
      // Out of sight, its lamp stays lit, and lights on a count that moves meanwhile.
      putOut('Strip 2 output')
      yield* scrolledTo(80 * 20)
      expect(target.querySelector('button[aria-label="Strip 2 output: clip, left"]')).toBeNull()
      yield* shown([two([7, 6])])
      yield* scrolledTo(0)
      expect(lit('Strip 2 output')).toEqual(['true', null])
      // Off the board, as a muted strip's, it shows nothing.
      yield* shown([])
      expect(levels('Strip 2 output')).toEqual(['0.000', '0.000'])
      expect(lit('Strip 2 output')).toEqual(['true', null])
    })
  ))

test("the master's fader has its scale's numbers, the strips' the marks alone", () =>
  page(({ target }) =>
    Effect.gen(function* () {
      yield* pressWindowButton(target, 'Mixer')
      const scales = Array.from(target.querySelectorAll('.fader-scale'), (scale) => ({
        master: scale.closest('.strip--master') !== null,
        text: scale.textContent
      }))
      expect(scales[0]).toEqual({ master: true, text: '+50−5−10−20−30−∞' })
      expect(scales.slice(1).every(({ master, text }) => !master && text === '')).toBe(true)
      expect(scales.length).toBeGreaterThan(2)
    })
  ))

test('the mixer draws the strips in sight as its rack scrolls', () =>
  page(({ target }) =>
    Effect.gen(function* () {
      yield* pressWindowButton(target, 'Mixer')
      const numbers = () =>
        Array.from(target.querySelectorAll('.rack .strip__index'), (index) => Number(index.textContent))
      const rack = Option.getOrThrow(Option.fromNullishOr(target.querySelector<HTMLElement>('.rack')))
      expect(numbers()[0]).toBe(1)
      rack.scrollLeft = 80 * 20
      rack.dispatchEvent(new Event('scroll'))
      yield* drawn()
      expect(numbers()[0]).toBe(20)
      expect(numbers()).not.toContain(1)
    })
  ))

test('the tempo is dragged in whole BPM, steps with the keys and goes back to 120 on a double click', () =>
  page(({ doc, target }) =>
    Effect.gen(function* () {
      const field = Option.getOrThrow(
        Option.fromNullishOr(target.querySelector('[role="spinbutton"][aria-label="Tempo"]'))
      )
      pointer(field, 'pointerdown', 100)
      pointer(field, 'pointermove', 70)
      yield* drawn()
      expect(field.textContent).toBe('130')
      pointer(field, 'pointermove', 40, { shiftKey: true })
      yield* drawn()
      expect(field.textContent).toBe('131')
      pointer(field, 'pointerup', 40)
      expect(readProject(doc).value.tempo).toBe(131)
      key(field, 'ArrowDown')
      keyUp(field)
      expect(readProject(doc).value.tempo).toBe(130)
      field.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      expect(readProject(doc).value.tempo).toBe(120)
    })
  ))

/** A key pressed with the focus on `target`; false if the page kept the browser from acting on it. */
const press = (target: EventTarget, init: KeyboardEventInit) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))

test('Cmd+Z or Ctrl+Z takes back the edit, with Shift or Ctrl+Y makes it again, and the buttons tell when they can', () =>
  page(({ target, button }) =>
    Effect.gen(function* () {
      const undo = button('Undo')
      const redo = button('Redo')
      const cell = button('Kick: mute')
      /** Whether the Kick is muted once the page has drawn what the action did. */
      const after = (act: () => void) =>
        Effect.sync(act).pipe(
          Effect.andThen(drawn()),
          Effect.map(() => pressed(cell))
        )
      const pressing = (init: KeyboardEventInit) => after(() => press(document.body, init))
      expect([undo.disabled, redo.disabled]).toEqual([true, true])
      expect(yield* after(() => cell.click())).toBe(true)
      expect([undo.disabled, redo.disabled]).toEqual([false, true])
      expect(press(cell, { key: 'z', metaKey: true })).toBe(false)
      expect(yield* after(() => {})).toBe(false)
      expect([undo.disabled, redo.disabled]).toEqual([true, false])
      expect(yield* pressing({ key: 'Z', ctrlKey: true, shiftKey: true })).toBe(true)
      expect(yield* pressing({ key: 'z', ctrlKey: true })).toBe(false)
      expect(yield* pressing({ key: 'y', ctrlKey: true })).toBe(true)
      // On a Russian layout: the key in Z's place.
      expect(yield* pressing({ key: 'я', code: 'KeyZ', metaKey: true })).toBe(false)
      // Cmd+Y is the browser's history; with Alt, or without Cmd or Ctrl, another key.
      expect(press(document.body, { key: 'y', metaKey: true })).toBe(true)
      expect(press(document.body, { key: 'z', metaKey: true, altKey: true, shiftKey: true })).toBe(true)
      expect(press(document.body, { key: 'z', shiftKey: true })).toBe(true)
      expect(yield* after(() => {})).toBe(false)
      expect(yield* after(() => redo.click())).toBe(true)
      expect(yield* after(() => undo.click())).toBe(false)
      // Text has an undo of its own.
      const field = target.appendChild(document.createElement('input'))
      expect(press(field, { key: 'z', metaKey: true })).toBe(true)
      expect(press(document.body, { key: 'z', metaKey: true, isComposing: true })).toBe(true)
      expect(yield* after(() => redo.click())).toBe(true)
    })
  ))

test('a turn of a knob is one step from press to release, and meanwhile undo does nothing, its buttons grey', () =>
  knobPage(({ doc, target, button }) =>
    Effect.gen(function* () {
      const knob = kickKnob(target)
      const undo = button('Undo')
      const cell = button('Kick: mute')
      cell.click()
      pointer(knob, 'pointerdown', 100)
      yield* drawn()
      expect(undo.disabled).toBe(true)
      press(knob, { key: 'z', metaKey: true })
      pointer(knob, 'pointermove', 90)
      pointer(knob, 'pointermove', 80)
      press(knob, { key: 'z', metaKey: true })
      yield* drawn()
      expect(pressed(cell)).toBe(true)
      pointer(knob, 'pointermove', 60)
      pointer(knob, 'pointerup', 60)
      yield* drawn()
      expect(kickAt(doc)).toBeCloseTo(1, 9)
      expect(undo.disabled).toBe(false)
      press(knob, { key: 'z', metaKey: true })
      yield* drawn()
      expect(kickVolume(doc)).toBe(at(0.8))
      expect(pressed(cell)).toBe(true)
      press(knob, { key: 'z', metaKey: true })
      yield* drawn()
      expect(pressed(cell)).toBe(false)
      expect(undo.disabled).toBe(true)
    })
  ))

test('two knobs turned at once are one step', () =>
  knobPage(({ doc, grid, target }) =>
    Effect.gen(function* () {
      // The Kick's in its window, the Snare's in its head.
      const kick = kickKnob(target)
      const snare = Option.getOrThrow(
        Option.fromNullishOr(grid.querySelector('[role="slider"][aria-label="Snare: volume"]'))
      )
      const volumes = () =>
        readProject(doc)
          .value.tracks.slice(0, 2)
          .map(({ strip }) => strip.volume)
      pointer(kick, 'pointerdown', 100, { pointerId: 1 })
      pointer(snare, 'pointerdown', 100, { pointerId: 2 })
      const ys = [90, 80, 70, 60]
      ys.forEach((y) => {
        pointer(kick, 'pointermove', y, { pointerId: 1 })
        pointer(snare, 'pointermove', 200 - y, { pointerId: 2 })
      })
      pointer(kick, 'pointerup', 60, { pointerId: 1 })
      pointer(snare, 'pointerup', 140, { pointerId: 2 })
      const [kickTurned, snareTurned] = volumes().map((volume) => paramPosition(trackVolume, volume))
      expect(kickTurned).toBeCloseTo(1, 9)
      expect(snareTurned).toBeCloseTo(0.6, 9)
      press(document.body, { key: 'z', metaKey: true })
      expect(volumes()).toEqual([at(0.8), at(0.8)])
    })
  ))

test("mute and tempo are taken back, a key's turn and a double click each a step; solo is not, it writes nothing", () =>
  page(({ doc, target, button }) =>
    Effect.gen(function* () {
      const tempo = Option.getOrThrow(
        Option.fromNullishOr(target.querySelector('[role="spinbutton"][aria-label="Tempo"]'))
      )
      button('Kick: mute').click()
      key(tempo, 'ArrowUp')
      key(tempo, 'ArrowUp')
      keyUp(tempo)
      tempo.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      button('Snare: solo').click()
      yield* drawn()
      const undone = () => {
        press(document.body, { key: 'z', metaKey: true })
        return readProject(doc).value
      }
      expect(undone().tempo).toBe(122)
      expect(undone().tempo).toBe(120)
      expect(undone().tracks[0].mute).toBe(false)
      yield* drawn()
      expect(pressed(button('Snare: solo'))).toBe(true)
      expect(button('Undo').disabled).toBe(true)
    })
  ))

const idleHint = 'Point at a control: this line says what it is and whose it is'

test('the hint line says what is under the pointer, anew as it changes, and with the pointer on none, what has the focus', () =>
  page(({ doc, target, button }) =>
    Effect.gen(function* () {
      const hint = () => target.querySelector('.hint')?.textContent
      const over = (element: Element) => element.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
      expect(hint()).toBe(idleHint)
      const cell = button('Kick: solo')
      over(cell)
      yield* drawn()
      expect(hint()).toBe("Solo Kick for you only; the other tabs won't hear the change")
      cell.click()
      yield* drawn()
      expect(hint()).toBe('Kick is soloed for you only; the other tabs hear the whole arrangement')
      const mute = button('Kick: mute')
      mute.focus()
      over(target)
      yield* drawn()
      expect(hint()).toBe('Mute Kick in the project, for everyone')
      mute.blur()
      yield* drawn()
      expect(hint()).toBe(idleHint)
      over(cell)
      cell.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: null }))
      yield* drawn()
      expect(hint()).toBe(idleHint)
      over(cell)
      yield* drawn()
      expect(hint()).toBe('Kick is soloed for you only; the other tabs hear the whole arrangement')
      // Taken away under the pointer, which hasn't moved.
      doc.transact(() => doc.getMap('tracks').delete(readProject(doc).value.tracks[0].id))
      yield* drawn(50)
      expect(cell.isConnected).toBe(false)
      expect(hint()).toBe(idleHint)
    })
  ))

/** A board with nothing on it but the master's `peaks` and `overs`, and the strips' `meters`. */
const boardWith = (
  peaks: readonly [number, number],
  overs: readonly [number, number] = [0, 0],
  meters: Telemetry['meters'] = []
): Telemetry => ({
  blocks: 1,
  epoch: 1,
  lostEvents: 0,
  lostNotes: 0,
  heapCalls: 0,
  peaks,
  playing: false,
  position: 0,
  loopTicks: 0,
  tempo: 120,
  streamLost: false,
  overs,
  meters,
  frame: 0
})

test("the meters draw the master's peaks in decibels, and a lamp lights when its side's count of overs moves, until it is clicked", () =>
  page(({ target, frame }) =>
    Effect.gen(function* () {
      yield* pressWindowButton(target, 'Mixer')
      const levels = () =>
        Array.from(target.querySelectorAll<HTMLElement>('.strip--master .meter__fill')).map((fill) =>
          fill.style.getPropertyValue('--level')
        )
      const lamps = Array.from(target.querySelectorAll<HTMLButtonElement>('.strip--master .meter-clip'))
      const lit = () => lamps.map((lamp) => lamp.getAttribute('data-lit'))
      /** The frame of `engine` with `peaks` and `overs`, once the page has drawn it. */
      const shown = (engine: number, peaks: readonly [number, number], overs: readonly [number, number]) =>
        Effect.sync(() => {
          frame.current = { engine, telemetry: boardWith(peaks, overs), heard: undefined, stats: undefined }
        }).pipe(Effect.andThen(drawn(50)))
      yield* pressWindowButton(target, 'Debug')
      /** The debug panel's level: the louder side's peak. */
      const level = () =>
        Option.getOrThrow(
          Option.fromNullishOr(
            Array.from(target.querySelectorAll('p')).find((line) => line.textContent.startsWith('Blocks'))
          )
        ).querySelectorAll('output')[2].textContent
      // Counted before the page first looked: not news.
      yield* shown(1, [0.1, 0.5], [0, 4])
      expect(levels()).toEqual(['0.667', '0.900'])
      expect(level()).toBe('−6.0 dB')
      expect(lit()).toEqual([null, null])
      // The peak fell back below full scale between two looks; the count tells.
      yield* shown(1, [0, 0.5], [0, 5])
      expect(levels()).toEqual(['0.000', '0.900'])
      expect(lit()).toEqual([null, 'true'])
      lamps[1].click()
      yield* drawn()
      expect(lit()).toEqual([null, null])
      // A new engine counts from zero: that's no over.
      yield* shown(2, [0, 0], [0, 0])
      expect(lit()).toEqual([null, null])
      expect(level()).toBe('−∞ dB')
      yield* shown(2, [1.5, 0], [1, 0])
      expect(levels()).toEqual(['1.000', '0.000'])
      expect(level()).toBe('+3.5 dB')
      expect(lit()).toEqual(['true', null])
    })
  ))

/** The windows' buttons on the transport bar, by title, and whether each is lit. */
const windowButtons = (target: HTMLElement) =>
  ['Arrangement', 'Piano roll', 'Mixer', 'Debug'].map((title) => [title, pressed(windowButton(target, title))] as const)

/** The titles of the windows on the desk. */
const windowsShown = (target: HTMLElement) =>
  Array.from(target.querySelectorAll('.dock-tab__title')).map((title) => title.textContent)

test('a new project opens with the Arrangement alone, its button lit; the others wait for their buttons', () =>
  page(({ target }) =>
    Effect.sync(() => {
      expect(windowsShown(target)).toEqual(['Arrangement'])
      expect(windowButtons(target)).toEqual([
        ['Arrangement', true],
        ['Piano roll', false],
        ['Mixer', false],
        ['Debug', false]
      ])
    })
  ))

test('the transport bar leads to the list of projects, first on it', () =>
  page(({ target }) =>
    Effect.sync(() => {
      const first = target.querySelector('.transport > *')
      expect(first?.textContent).toBe('Projects')
      expect(first?.getAttribute('href')).toBe(import.meta.env.BASE_URL)
    })
  ))

test("a window's button opens it and closes it again; its tab's close button closes it too", () =>
  page(({ target, button }) =>
    Effect.gen(function* () {
      yield* pressWindowButton(target, 'Mixer')
      expect(windowsShown(target)).toEqual(['Arrangement', 'Mixer'])
      expect(target.querySelector('.strip')).not.toBeNull()
      expect(windowButtons(target)[2]).toEqual(['Mixer', true])
      yield* pressWindowButton(target, 'Mixer')
      expect(windowsShown(target)).toEqual(['Arrangement'])
      expect(target.querySelector('.strip')).toBeNull()
      yield* pressWindowButton(target, 'Mixer')
      button('Close Arrangement').click()
      yield* drawn(50)
      expect(windowsShown(target)).toEqual(['Mixer'])
      expect(windowButtons(target)[0]).toEqual(['Arrangement', false])
    })
  ))

/** What stands beside the title of the window with this title. */
const subOf = (target: HTMLElement, title: string) =>
  Array.from(target.querySelectorAll('.dock-tab'))
    .find((tab) => tab.querySelector('.dock-tab__title')?.textContent === title)
    ?.querySelector('.dock-tab__sub')?.textContent

/** The floating window a body stands in. */
const frameOf = (target: HTMLElement, name: string) =>
  Option.getOrThrow(trackWindow(target, name)).closest('.dv-resize-container')

/** The labels of the knobs in it, and what they read. */
const knobsIn = (element: Element) =>
  Array.from(element.querySelectorAll('[role="slider"]'), (knob) => [
    knob.getAttribute('aria-label'),
    knob.getAttribute('aria-valuetext')
  ])

test("a track's name opens its window: its pan and volume and mixer strip, a sampler nothing more; a second click closes it", () =>
  page(({ grid, target }) =>
    Effect.gen(function* () {
      nameButton(grid, 'Kick').click()
      yield* drawn(50)
      expect(windowsShown(target)).toEqual(['Arrangement', 'Kick'])
      expect(subOf(target, 'Kick')).toBe('Sampler')
      expect(knobsIn(Option.getOrThrow(trackWindow(target, 'Kick')))).toEqual([
        ['Pan', 'center'],
        ['Volume', '−5.2 dB']
      ])
      nameButton(grid, 'Kick').click()
      yield* drawn(50)
      expect(windowsShown(target)).toEqual(['Arrangement'])
    })
  ))

test("a second click on a track's name closes its window, though the click takes the focus into the Arrangement", () =>
  page(({ grid, target }) =>
    Effect.gen(function* () {
      const kick = nameButton(grid, 'Kick')
      kick.focus()
      kick.click()
      yield* drawn(50)
      // Turned in its window, a knob takes the focus there.
      const knob = kickKnob(target)
      pointer(knob, 'pointerdown', 100)
      pointer(knob, 'pointerup', 100)
      yield* drawn(50)
      expect(kick.getAttribute('aria-pressed')).toBe('true')
      kick.focus()
      kick.click()
      yield* drawn(50)
      expect(windowsShown(target)).toEqual(['Arrangement'])
      expect(kick.getAttribute('aria-pressed')).toBe('false')
    })
  ))

/** A parameter of the last track's synth, as the document has it. */
const lastSynth = (doc: Y.Doc, param: ParamId<typeof plugins.synth>) =>
  Option.fromUndefinedOr(readProject(doc).value.tracks.at(-1)).pipe(
    Option.flatMap(({ instrument }) => instrument),
    Option.filter((instrument) => instrument.name === 'synth'),
    Option.map(({ params }) => params[param]),
    Option.getOrUndefined
  )

const lastShape = (doc: Y.Doc) => lastSynth(doc, 'osc1.shape')

/** The controls of one of a track's groups, such as an oscillator's, in its window. */
const groupIn = (window: HTMLElement, name: string) =>
  Option.getOrThrow(Option.fromNullishOr(window.querySelector<HTMLElement>(`[role="group"][aria-label="${name}"]`)))

test("a synth's shape is chosen by a row of its waves, one lit: a click or an arrow writes it, Cmd+Z takes it back", () =>
  page(({ doc, grid, target, button }) =>
    Effect.gen(function* () {
      button('Add a track').click()
      yield* drawn()
      nameButton(grid, 'Synth').click()
      yield* drawn(50)
      const synth = groupIn(Option.getOrThrow(trackWindow(target, 'Synth')), 'Osc 1')
      const choices = () => Array.from(synth.querySelectorAll<HTMLButtonElement>('[role="radio"]'))
      const lit = () =>
        choices()
          .filter((choice) => choice.getAttribute('aria-checked') === 'true')
          .map((choice) => choice.getAttribute('aria-label'))
      const hint = () => target.querySelector('.hint')?.textContent
      const over = (element: Element) => element.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
      expect(choices().map((choice) => choice.getAttribute('aria-label'))).toEqual([
        'Sine',
        'Triangle',
        'Square',
        'Saw',
        'Noise'
      ])
      expect(choices().every((choice) => choice.querySelector('svg path') !== null)).toBe(true)
      expect(lit()).toEqual(['Saw'])
      // One stop for Tab: the chosen one.
      expect(choices().map((choice) => choice.tabIndex)).toEqual([-1, -1, -1, 0, -1])
      // The lit one again changes nothing, and so writes nothing: no step of undo that undoes nothing.
      const updates = counted(doc)
      choices()[3].click()
      yield* drawn()
      expect(updates.count).toBe(0)
      over(choices()[2])
      yield* drawn()
      expect(hint()).toBe('Synth synth osc 1 shape: choose square in the project')
      choices()[2].click()
      yield* drawn()
      expect(lastShape(doc)).toBe(2)
      expect(lit()).toEqual(['Square'])
      expect(hint()).toBe('Synth synth osc 1 shape: square in the project')
      // Arrows from the chosen one, round from the last to the first; the focus goes along.
      const arrow = (key: string) =>
        Effect.gen(function* () {
          press(Option.getOrThrow(Option.fromUndefinedOr(choices()[lastShape(doc) ?? 0])), { key })
          yield* drawn()
          return lastShape(doc)
        })
      expect(yield* arrow('ArrowRight')).toBe(3)
      expect(yield* arrow('ArrowDown')).toBe(4)
      expect(yield* arrow('ArrowRight')).toBe(0)
      expect(document.activeElement).toBe(choices()[0])
      expect(yield* arrow('ArrowLeft')).toBe(4)
      expect(yield* arrow('ArrowUp')).toBe(3)
      expect(lit()).toEqual(['Saw'])
      // Held down, it chooses once.
      press(choices()[3], { key: 'ArrowRight', repeat: true })
      yield* drawn()
      expect(lastShape(doc)).toBe(3)
      // Each a step of undo of its own.
      press(document.body, { key: 'z', metaKey: true })
      yield* drawn()
      expect(lastShape(doc)).toBe(4)
      press(document.body, { key: 'z', metaKey: true })
      yield* drawn()
      expect(lastShape(doc)).toBe(0)
      expect(lit()).toEqual(['Sine'])
    })
  ))

test("a synth's Coarse turns a semitone at a time, by a key or a drag, and its hint names the oscillator", () =>
  page(({ doc, target, button, grid }) =>
    Effect.gen(function* () {
      button('Add a track').click()
      yield* drawn()
      nameButton(grid, 'Synth').click()
      yield* drawn(50)
      const knob = Option.getOrThrow(
        Option.fromNullishOr(
          groupIn(Option.getOrThrow(trackWindow(target, 'Synth')), 'Osc 2').querySelector(
            '[role="slider"][aria-label="Coarse"]'
          )
        )
      )
      key(knob, 'ArrowUp')
      key(knob, 'ArrowUp')
      yield* drawn()
      expect(knob.getAttribute('aria-valuetext')).toBe('−10 st')
      keyUp(knob)
      expect(lastSynth(doc, 'osc2.coarse')).toBe(-10)
      knob.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
      yield* drawn()
      expect(target.querySelector('.hint')?.textContent).toMatch(/^Synth synth osc 2 coarse −10 st: in the project/)
      // A little over a semitone up: a whole one, in the knob and the document.
      pointer(knob, 'pointerdown', 100)
      pointer(knob, 'pointermove', 95)
      yield* drawn()
      expect(knob.getAttribute('aria-valuenow')).toBe('-9')
      pointer(knob, 'pointerup', 95)
      expect(lastSynth(doc, 'osc2.coarse')).toBe(-9)
    })
  ))

test("a track's name shows its window in place of the one in front, closing the others; with Alt, beside it", () =>
  page(({ grid, target, button }) =>
    Effect.gen(function* () {
      button('Add a track').click()
      yield* drawn()
      nameButton(grid, 'Kick').click()
      yield* drawn(50)
      const place = frameOf(target, 'Kick')
      nameButton(grid, 'Synth').click()
      yield* drawn(50)
      expect(windowsShown(target)).toEqual(['Arrangement', 'Synth'])
      expect(frameOf(target, 'Synth')).toBe(place)
      // The synth's own controls under its name, after the track's knobs: an oscillator to a row, Osc 2 an octave
      // down and Osc 3 two, unmixed; then the envelope's, a short note at full level.
      const synth = Option.getOrThrow(trackWindow(target, 'Synth'))
      expect(knobsIn(synth)).toEqual([
        ['Pan', 'center'],
        ['Volume', '−5.2 dB'],
        ['Coarse', '0 st'],
        ['Fine', '0 ct'],
        ['Coarse', '−12 st'],
        ['Fine', '0 ct'],
        ['Mix', '0%'],
        ['Coarse', '−24 st'],
        ['Fine', '0 ct'],
        ['Mix', '0%'],
        ['Delay', '0 ms'],
        ['Attack', '3 ms'],
        ['Hold', '0 ms'],
        ['Decay', '500 ms'],
        ['Sustain', '100%'],
        ['Release', '100 ms']
      ])
      expect(synth.querySelector('.track-settings__instrument .cap')?.textContent).toBe('Synth')
      const rows = Array.from(synth.querySelectorAll('.track-settings__instrument [role="group"]'), (row) => [
        row.getAttribute('aria-label'),
        row.querySelector('[role="radiogroup"]')?.getAttribute('aria-label')
      ])
      expect(rows).toEqual([
        ['Osc 1', 'Shape'],
        ['Osc 2', 'Shape'],
        ['Osc 3', 'Shape'],
        ['Envelope', undefined]
      ])
      nameButton(grid, 'Snare').dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true }))
      yield* drawn(50)
      expect(windowsShown(target)).toEqual(['Arrangement', 'Synth', 'Snare'])
      expect(frameOf(target, 'Snare')).not.toBe(place)
      // In place of the Snare's, in front, and the Synth's closed.
      const front = frameOf(target, 'Snare')
      nameButton(grid, 'Kick').click()
      yield* drawn(50)
      expect(windowsShown(target)).toEqual(['Arrangement', 'Kick'])
      expect(frameOf(target, 'Kick')).toBe(front)
    })
  ))

test("a track's name opens its window in place of the track window last turned to, not the newest", () =>
  page(({ grid, target, button }) =>
    Effect.gen(function* () {
      button('Add a track').click()
      yield* drawn()
      nameButton(grid, 'Kick').click()
      yield* drawn(50)
      nameButton(grid, 'Snare').dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true }))
      yield* drawn(50)
      const kickPlace = frameOf(target, 'Kick')
      // Back to the Kick's window: a knob there turned.
      const knob = kickKnob(target)
      pointer(knob, 'pointerdown', 100)
      pointer(knob, 'pointerup', 100)
      const synth = nameButton(grid, 'Synth')
      synth.focus()
      synth.click()
      yield* drawn(50)
      expect(windowsShown(target)).toEqual(['Arrangement', 'Synth'])
      expect(frameOf(target, 'Synth')).toBe(kickPlace)
    })
  ))

test("a track's window is named by the track to screen readers, and dims as its head does while not heard", () =>
  page(({ grid, target, button }) =>
    Effect.gen(function* () {
      nameButton(grid, 'Kick').click()
      yield* drawn(50)
      expect(target.querySelector('[role="tab"][aria-label="Kick"]')).not.toBeNull()
      const settings = Option.getOrThrow(
        Option.flatMapNullishOr(trackWindow(target, 'Kick'), (window) => window.querySelector('.track-settings'))
      )
      expect(settings.getAttribute('data-unheard')).toBe('false')
      button('Kick: mute').click()
      yield* drawn()
      expect(settings.getAttribute('data-unheard')).toBe('true')
    })
  ))

test("a track's window turns the same pan and volume as its head", () =>
  page(({ doc, grid, target }) =>
    Effect.gen(function* () {
      nameButton(grid, 'Kick').click()
      yield* drawn(50)
      const pan = Option.getOrThrow(
        Option.flatMapNullishOr(trackWindow(target, 'Kick'), (window) =>
          window.querySelector('[role="slider"][aria-label="Pan"]')
        )
      )
      key(pan, 'End')
      keyUp(pan)
      yield* drawn()
      expect(readProject(doc).value.tracks[0].strip.pan).toBe(1)
      expect(grid.querySelector('[aria-label="Kick: pan"]')?.getAttribute('aria-valuetext')).toBe('100% right')
    })
  ))

/** Past the write of a layout that opened or closed a window, which goes at once. */
const saved = drawn(50)

test('the layout is kept for the project: opened again, it shows the windows as they were left; a new project starts afresh', () => {
  const views = memoryViews()
  const doc = projectDoc()
  return page(
    ({ target, button }) =>
      Effect.gen(function* () {
        yield* pressWindowButton(target, 'Debug')
        yield* pressWindowButton(target, 'Mixer')
        button('Close Mixer').click()
        yield* saved
      }),
    {},
    {},
    { views, doc }
  )
    .then(() =>
      page(
        ({ target }) =>
          Effect.sync(() => {
            expect(windowsShown(target)).toEqual(['Arrangement', 'Debug'])
            expect(windowButtons(target)).toEqual([
              ['Arrangement', true],
              ['Piano roll', false],
              ['Mixer', false],
              ['Debug', true]
            ])
          }),
        {},
        {},
        { views, doc }
      )
    )
    .then(() =>
      page(
        ({ target }) =>
          Effect.sync(() => {
            expect(windowsShown(target)).toEqual(['Arrangement'])
          }),
        {},
        {},
        { views }
      )
    )
})

/** `views` with `saved` kept for the project in `doc`. */
const viewsWith = (doc: Y.Doc, saved: unknown) => {
  const views = memoryViews()
  Effect.runSync(views.set(`layout:${Option.getOrThrow(readProjectId(doc))}`, JSON.stringify(saved)))
  return views
}

test.each<[string, unknown]>([
  ["the dock can't take", { version: 1, layout: JSON.stringify({ grid: 'none of it' }) }],
  ['not in JSON', { version: 1, layout: '{ grid' }],
  ['of another version', { version: 2, layout: '{}' }],
  ['not a view', 'not a view']
])('a saved layout %s is left for the first one', (_, saved) => {
  const doc = projectDoc()
  return page(
    ({ target }) =>
      Effect.sync(() => {
        expect(windowsShown(target)).toEqual(['Arrangement'])
      }),
    {},
    {},
    { views: viewsWith(doc, saved), doc }
  )
})

/** The Arrangement and Debug as two tabs of one docked group, the Arrangement in front. */
const tabbed = {
  grid: {
    root: {
      type: 'branch',
      data: [
        { type: 'leaf', data: { views: ['arrangement', 'debug'], activeView: 'arrangement', id: '1' }, size: 100 }
      ],
      size: 100
    },
    width: 100,
    height: 100,
    orientation: 'HORIZONTAL'
  },
  panels: {
    arrangement: { id: 'arrangement', contentComponent: 'arrangement', title: 'Arrangement' },
    debug: { id: 'debug', contentComponent: 'debug', title: 'Debug' }
  },
  activeGroup: '1'
}

test("a window behind another tab isn't lit, and its button brings it forward rather than closing it", () => {
  const doc = projectDoc()
  return page(
    ({ target }) =>
      Effect.gen(function* () {
        expect(windowsShown(target)).toEqual(['Arrangement', 'Debug'])
        expect(windowButtons(target)).toEqual([
          ['Arrangement', true],
          ['Piano roll', false],
          ['Mixer', false],
          ['Debug', false]
        ])
        yield* pressWindowButton(target, 'Debug')
        expect(windowsShown(target)).toEqual(['Arrangement', 'Debug'])
        expect(windowButtons(target)).toEqual([
          ['Arrangement', false],
          ['Piano roll', false],
          ['Mixer', false],
          ['Debug', true]
        ])
      }),
    {},
    {},
    { views: viewsWith(doc, { version: 1, layout: JSON.stringify(tabbed) }), doc }
  )
})

test("a press with Shift in a floating window turns the knob finely, and doesn't take the window along", () =>
  knobPage(({ doc, target }) =>
    Effect.gen(function* () {
      const knob = kickKnob(target)
      const window = Option.getOrThrow(Option.fromNullishOr(knob.closest<HTMLElement>('.dv-resize-container')))
      pointer(knob, 'pointerdown', 100, { shiftKey: true })
      pointer(knob, 'pointermove', 60, { shiftKey: true })
      // The dock marks a window it drags.
      expect(window.classList.contains('dv-resize-container-dragging')).toBe(false)
      pointer(knob, 'pointerup', 60, { shiftKey: true })
      yield* drawn()
      expect(kickAt(doc)).toBeCloseTo(0.82, 9)
      expect(document.activeElement).toBe(knob)
    })
  ))

test("a window's button brings an open window forward first, and closes it once it is in front", () =>
  page(({ target }) =>
    Effect.gen(function* () {
      // The Mixer opened last, in front of the Arrangement.
      yield* pressWindowButton(target, 'Mixer')
      yield* pressWindowButton(target, 'Arrangement')
      expect(windowsShown(target)).toEqual(['Arrangement', 'Mixer'])
      expect(windowButton(target, 'Arrangement').dataset.hint).toContain('in front: a click closes it')
      expect(windowButton(target, 'Mixer').dataset.hint).toContain('open: a click brings it forward')
      yield* pressWindowButton(target, 'Arrangement')
      expect(windowsShown(target)).toEqual(['Mixer'])
      expect(windowButton(target, 'Arrangement').dataset.hint).toContain('Show Arrangement')
    })
  ))

test('only a build for development has Debug: the bar holds the main windows', () => {
  expect(deskWindows(true)).toEqual(['arrangement', 'piano-roll', 'mixer', 'debug'])
  expect(deskWindows(false)).toEqual(['arrangement', 'piano-roll', 'mixer'])
})

test("a build for users has no Debug button, and doesn't take a saved layout that holds Debug", () => {
  vi.stubEnv('DEV', false)
  const doc = projectDoc()
  return page(
    ({ target }) =>
      Effect.sync(() => {
        const titles = Array.from(target.querySelectorAll('.btn--window')).map((button) => button.textContent)
        expect(titles).toEqual(['Arrangement', 'Piano roll', 'Mixer'])
        expect(windowsShown(target)).toEqual(['Arrangement'])
      }),
    {},
    {},
    { views: viewsWith(doc, { version: 1, layout: JSON.stringify(tabbed) }), doc }
  ).finally(() => vi.unstubAllEnvs())
})

test("a track's window goes with its track, by Cmd+Z on + or deleted while the page was away; else it comes back with the page", () => {
  const views = memoryViews()
  const doc = projectDoc()
  return page(
    ({ grid, target, button }) =>
      Effect.gen(function* () {
        button('Add a track').click()
        yield* drawn()
        nameButton(grid, 'Synth').click()
        yield* drawn(50)
        expect(windowsShown(target)).toEqual(['Arrangement', 'Synth'])
        press(document.body, { key: 'z', metaKey: true })
        yield* drawn(50)
        expect(windowsShown(target)).toEqual(['Arrangement'])
        nameButton(grid, 'Kick').click()
        yield* saved
      }),
    {},
    {},
    { views, doc }
  )
    .then(() =>
      page(
        ({ target }) => Effect.sync(() => expect(windowsShown(target)).toEqual(['Arrangement', 'Kick'])),
        {},
        {},
        { views, doc }
      )
    )
    .then(() => {
      doc.transact(() => doc.getMap('tracks').delete(readProject(doc).value.tracks[0].id))
      return page(
        ({ target }) => Effect.sync(() => expect(windowsShown(target)).toEqual(['Arrangement'])),
        {},
        {},
        { views, doc }
      )
    })
})

test("a track's window that names no track, as a broken saved layout may hold, doesn't open", () => {
  const views = memoryViews()
  const doc = projectDoc()
  const key = `layout:${Option.getOrThrow(readProjectId(doc))}`
  return page(
    ({ grid }) =>
      Effect.gen(function* () {
        nameButton(grid, 'Kick').click()
        yield* saved
      }),
    {},
    {},
    { views, doc }
  ).then(() => {
    // The dock's layout is JSON of its own inside the saved view.
    const view = JSON.parse(Option.getOrThrow(Option.fromUndefinedOr(Effect.runSync(views.get(key)))))
    const layout = JSON.parse(view.layout)
    const track = Option.getOrThrow(
      Option.fromUndefinedOr(Object.keys(layout.panels).find((id) => id.startsWith('track:')))
    )
    layout.panels[track].params = { track: '' }
    Effect.runSync(views.set(key, JSON.stringify({ ...view, layout: JSON.stringify(layout) })))
    return page(
      ({ target }) =>
        Effect.sync(() => {
          expect(windowsShown(target)).toEqual(['Arrangement'])
          // Not even as an empty window, with no title to close it by.
          expect(target.querySelectorAll('.dv-tab')).toHaveLength(1)
        }),
      {},
      {},
      { views, doc }
    )
  })
})

/** The notes of the clips, each by its track's name, where it starts, how high and how long. */
const notesByName = (doc: Y.Doc) => {
  const { tracks, clips, patterns } = readProject(doc).value
  return clips.flatMap(({ track, pattern }) =>
    (patterns.find(({ id }) => id === pattern)?.notes ?? []).map(({ tick, key, length }) => ({
      track: tracks.find(({ id }) => id === track)?.name,
      tick,
      key,
      length
    }))
  )
}

/** The first clip on the track of this name. */
const clipOn = (doc: Y.Doc, name: string) => {
  const { tracks, clips } = readProject(doc).value
  const track = Option.getOrThrow(Option.fromUndefinedOr(tracks.find((one) => one.name === name))).id
  return Option.getOrThrow(Option.fromUndefinedOr(clips.find((clip) => clip.track === track)))
}

/** The notes of the Kick's clip. */
const kickNotes = (doc: Y.Doc) =>
  readProject(doc).value.patterns.find(({ id }) => id === clipOn(doc, 'Kick').pattern)?.notes ?? []

/** How many bars the Kick's clip plays, as long as its pattern. */
const kickClipBars = (doc: Y.Doc) => patternEnd(kickNotes(doc)) / barTicks

/** A note of the track's clip put by another client. */
const noteElsewhere = (doc: Y.Doc, name: string, step: number, key: number, steps = 1) =>
  addNote(doc, elsewhere, clipOn(doc, name).id, {
    tick: Tick(step * stepTicks),
    key: MidiKey(key),
    length: steps * stepTicks
  })

// happy-dom lays nothing out: the roll gets the size a window would give it, four bars wide and all but a few keys high,
// so a point past it is past it, as in a browser; none behind a tab, where the dock takes it out of the page.
const rollSize = { clientWidth: keysWidth + 4 * barSteps * stepWidth, clientHeight: rulerHeight + 120 * rowHeight }
const rollBehindTab = { now: false }
// The arrangement, eight bars wide and ten tracks high; none behind a tab, as the roll.
const arrangementSize = {
  clientWidth: headsWidth + 8 * barWidth,
  clientHeight: arrangementRulerHeight + 10 * trackHeight
}
const arrangementBehindTab = { now: false }
Object.entries(rollSize).forEach(([name, size]) => {
  const laid = Object.getOwnPropertyDescriptor(Element.prototype, name)
  Object.defineProperty(HTMLElement.prototype, name, {
    configurable: true,
    get(this: HTMLElement) {
      return Boolean.match(this.classList.contains('roll'), {
        onTrue: () => Boolean.match(rollBehindTab.now, { onTrue: () => 0, onFalse: () => size }),
        onFalse: () =>
          Boolean.match(this.classList.contains('arrangement'), {
            onTrue: () =>
              Boolean.match(arrangementBehindTab.now, {
                onTrue: () => 0,
                onFalse: () => arrangementSize[name as keyof typeof arrangementSize]
              }),
            onFalse: () => laid?.get?.call(this) ?? 0
          })
      })
    }
  })
})

/** The piano roll's grid, scrolled by the wheel to the highest key. */
const rollIn = (target: HTMLElement) =>
  Effect.gen(function* () {
    const roll = Option.getOrThrow(Option.fromNullishOr(target.querySelector<HTMLElement>('.roll')))
    expect(
      roll.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -(10 ** 6), deltaMode: 0 }))
    ).toBe(false)
    yield* drawn()
    const view: View = { width: 0, height: 0, top: 0, left: 0 }
    /** A press, a move or a release in the middle of the key's row at the step, with this button. */
    const at = (
      type: string,
      step: number,
      key: number,
      { button = 0, buttons = 1, ctrlKey = false, pointerId = 1 } = {}
    ) =>
      roll.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          button,
          buttons,
          ctrlKey,
          pointerId,
          clientX: xOf(view, (step + 0.5) * stepTicks),
          clientY: yOf(view, key) + rowHeight / 2
        })
      )
    /** A turn of the wheel over the roll, with the keys held: happy-dom's wheel takes none. */
    const wheel = ({ shiftKey = false, ctrlKey = false, ...init }: WheelEventInit) => {
      const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init })
      Object.defineProperties(event, { shiftKey: { value: shiftKey }, ctrlKey: { value: ctrlKey } })
      return roll.dispatchEvent(event)
    }
    /** A press, a move or a release at the point on the roll, with the left button. */
    const atPoint = (type: string, { x, y }: { readonly x: number; readonly y: number }, buttons = 1) =>
      roll.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          button: 0,
          buttons,
          pointerId: 1,
          clientX: x,
          clientY: y
        })
      )
    /** A press and a release in one place, as a click. */
    const click = (step: number, key: number) => {
      at('pointerdown', step, key)
      at('pointerup', step, key, { buttons: 0 })
    }
    /** A press, moves to each place after, and a release at the last. */
    const drag = (...places: ReadonlyArray<readonly [step: number, key: number]>) => {
      const [[step, key], ...rest] = places
      at('pointerdown', step, key)
      rest.forEach(([step, key]) => at('pointermove', step, key, { button: -1 }))
      const [lastStep, lastKey] = places[places.length - 1]
      at('pointerup', lastStep, lastKey, { buttons: 0 })
    }
    return { roll, at, atPoint, click, drag, wheel }
  })

test('the piano roll puts a note where it is clicked, on its step, as long as the note last touched; Cmd+Z takes it back', () =>
  page(({ doc, target, button }) =>
    Effect.gen(function* () {
      yield* openKickClip(target)
      // No channel chosen and none with notes: the first.
      expect(subOf(target, 'Piano roll')).toBe('Kick')
      const { click } = yield* rollIn(target)
      click(2, 64)
      yield* drawn()
      expect(notesByName(doc)).toEqual([{ track: 'Kick', tick: 2 * stepTicks, key: 64, length: stepTicks }])
      noteElsewhere(doc, 'Kick', 8, 67, 3)
      yield* drawn()
      // A click on a note takes its length, wherever on it, and writes nothing.
      expect(updatesDuring(doc, () => click(10, 67))).toBe(0)
      click(4, 62)
      yield* drawn()
      expect(notesByName(doc)).toContainEqual({ track: 'Kick', tick: 4 * stepTicks, key: 62, length: 3 * stepTicks })
      // Whole into the next bar, the pattern growing to it.
      click(15, 60)
      yield* drawn()
      expect(notesByName(doc)).toContainEqual({ track: 'Kick', tick: 15 * stepTicks, key: 60, length: 3 * stepTicks })
      button('Undo').click()
      yield* drawn()
      expect(
        notesByName(doc)
          .map(({ key }) => key)
          .toSorted()
      ).toEqual([62, 64, 67])
    })
  ))

test('a right click in the piano roll erases a note; a drag with it, all it passes over, as one step of undo', () =>
  page(({ doc, target, button }) =>
    Effect.gen(function* () {
      ;[0, 2, 4].forEach((step) => noteElsewhere(doc, 'Kick', step, 64))
      noteElsewhere(doc, 'Kick', 8, 60)
      yield* drawn()
      yield* openKickClip(target)
      const { roll, at } = yield* rollIn(target)
      // The browser's menu stays shut.
      expect(roll.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))).toBe(false)
      at('pointerdown', 8, 60, { button: 2, buttons: 2 })
      at('pointerup', 8, 60, { button: 2, buttons: 0 })
      yield* drawn()
      expect(
        notesByName(doc)
          .map(({ tick }) => tick / stepTicks)
          .toSorted()
      ).toEqual([0, 2, 4])
      at('pointerdown', 0, 64, { button: 2, buttons: 2 })
      at('pointermove', 2.5, 64, { button: -1, buttons: 2 })
      at('pointermove', 4.5, 64, { button: -1, buttons: 2 })
      at('pointerup', 4.5, 64, { button: 2, buttons: 0 })
      yield* drawn()
      expect(notesByName(doc)).toEqual([])
      button('Undo').click()
      yield* drawn()
      expect(notesByName(doc)).toHaveLength(3)
      // Ctrl with a click is no click where the browser doesn't take it as a right click...
      at('pointerdown', 2, 64, { ctrlKey: true })
      at('pointerup', 2, 64, { ctrlKey: true, buttons: 0 })
      yield* drawn()
      expect(notesByName(doc)).toHaveLength(3)
      // ...and erases where it does, as a Mac's does, telling so with its menu.
      expect(at('contextmenu', 2, 64, { ctrlKey: true, buttons: 0 })).toBe(false)
      yield* drawn()
      expect(
        notesByName(doc)
          .map(({ tick }) => tick / stepTicks)
          .toSorted()
      ).toEqual([0, 4])
    })
  ))

/** The notes by name, earliest first, lowest first at one tick. */
const notesInTime = (doc: Y.Doc) => notesByName(doc).toSorted((a, b) => a.tick - b.tick || a.key - b.key)

/** How many updates the document makes while acting. */
const updatesDuring = (doc: Y.Doc, act: () => void) => {
  const seen = { count: 0 }
  const count = () => {
    seen.count += 1
  }
  doc.on('update', count)
  act()
  doc.off('update', count)
  return seen.count
}

test('a drag in the piano roll moves a note by steps and keys, written once let go as one step; Cmd+Z does nothing meanwhile', () =>
  page(({ doc, target, button }) =>
    Effect.gen(function* () {
      noteElsewhere(doc, 'Kick', 2, 64)
      yield* drawn()
      yield* openKickClip(target)
      const { at, click } = yield* rollIn(target)
      click(12, 70)
      yield* drawn()
      const moving = updatesDuring(doc, () => {
        at('pointerdown', 2, 64)
        // Less than half a step and no key yet: where it was.
        at('pointermove', 2.4, 64, { button: -1 })
        at('pointermove', 5.2, 67, { button: -1 })
      })
      expect(moving).toBe(0)
      yield* drawn()
      expect(button('Undo').disabled).toBe(true)
      expect(press(document.body, { key: 'z', metaKey: true })).toBe(false)
      yield* drawn()
      expect(notesByName(doc)).toHaveLength(2)
      expect(updatesDuring(doc, () => at('pointerup', 5.2, 67, { buttons: 0 }))).toBe(1)
      yield* drawn()
      expect(notesInTime(doc)).toEqual([
        { track: 'Kick', tick: 5 * stepTicks, key: 67, length: stepTicks },
        { track: 'Kick', tick: 12 * stepTicks, key: 70, length: stepTicks }
      ])
      button('Undo').click()
      yield* drawn()
      expect(notesByName(doc)).toContainEqual({ track: 'Kick', tick: 2 * stepTicks, key: 64, length: stepTicks })
      expect(notesByName(doc)).toHaveLength(2)
    })
  ))

test("a note's right edge in the piano roll makes it longer or shorter by steps, a step at least, past the pattern's end too; the next is as long", () =>
  page(({ doc, target, button }) =>
    Effect.gen(function* () {
      noteElsewhere(doc, 'Kick', 4, 64, 2)
      yield* drawn()
      yield* openKickClip(target)
      const { roll, at, click, drag } = yield* rollIn(target)
      const length = () => notesByName(doc).map(({ length }) => length / stepTicks)
      // Over the note, a cursor to move it; over its last pixels, one to stretch it.
      at('pointermove', 4.5, 64, { button: -1, buttons: 0 })
      yield* drawn()
      expect(roll.dataset.grab).toBe('move')
      at('pointermove', 5.4, 64, { button: -1, buttons: 0 })
      yield* drawn()
      expect(roll.dataset.grab).toBe('stretch')
      at('pointermove', 7.5, 64, { button: -1, buttons: 0 })
      yield* drawn()
      expect(roll.dataset.grab).toBe('none')
      drag([5.4, 64], [8.2, 66])
      yield* drawn()
      expect(notesByName(doc)).toEqual([{ track: 'Kick', tick: 4 * stepTicks, key: 64, length: 5 * stepTicks }])
      drag([8.4, 64], [1.4, 64])
      yield* drawn()
      expect(length()).toEqual([1])
      drag([4.4, 64], [30.4, 64])
      yield* drawn()
      expect(length()).toEqual([27])
      click(0, 70)
      yield* drawn()
      expect(notesInTime(doc).map(({ length }) => length / stepTicks)).toEqual([27, 27])
      button('Undo').click()
      button('Undo').click()
      yield* drawn()
      expect(length()).toEqual([1])
    })
  ))

test('a press on empty ground in the piano roll puts a note that goes with the pointer until let go, in place of one there', () =>
  page(({ doc, target, button }) =>
    Effect.gen(function* () {
      noteElsewhere(doc, 'Kick', 6, 67, 2)
      yield* drawn()
      yield* openKickClip(target)
      const { drag } = yield* rollIn(target)
      drag([1, 60], [3, 62], [6, 67])
      yield* drawn()
      expect(notesByName(doc)).toEqual([{ track: 'Kick', tick: 6 * stepTicks, key: 67, length: stepTicks }])
      button('Undo').click()
      yield* drawn()
      expect(notesByName(doc)).toEqual([{ track: 'Kick', tick: 6 * stepTicks, key: 67, length: 2 * stepTicks }])
    })
  ))

test('a note dragged in the piano roll stays under the pointer as the wheel scrolls the rows', () =>
  page(({ doc, target }) =>
    Effect.gen(function* () {
      noteElsewhere(doc, 'Kick', 0, 100)
      yield* drawn()
      yield* openKickClip(target)
      const { roll, at } = yield* rollIn(target)
      at('pointerdown', 0, 100)
      roll.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 2 * rowHeight }))
      yield* drawn()
      at('pointerup', 0, 100, { buttons: 0 })
      yield* drawn()
      expect(notesByName(doc)).toEqual([{ track: 'Kick', tick: 0, key: 98, length: stepTicks }])
    })
  ))

/** A bar of the piano roll, in pixels. */
const rollBar = barSteps * stepWidth

/** The page's frames heard so many bars into a loop of sixteen of the arrangement, or none heard, as stopped; a few frames on. */
const heardAt = (frame: { current: Frame | undefined }, bars: Option.Option<number>) => {
  frame.current = {
    engine: 1,
    telemetry: undefined,
    heard: Option.getOrUndefined(Option.map(bars, (bars) => ({ tick: bars * barTicks, loop: 16 * barTicks }))),
    stats: undefined
  }
  return drawn(50)
}

test("the piano roll scrolls across with a swipe and with Shift and the wheel, up to the bar after the pattern's end", () =>
  page(({ doc, target }) =>
    Effect.gen(function* () {
      // Eight bars long, in a roll four bars wide: as far as the ninth bar, five bars across.
      noteElsewhere(doc, 'Kick', 8 * barSteps - 1, 40)
      yield* drawn()
      yield* openKickClip(target)
      const { click, at, wheel } = yield* rollIn(target)
      /** The note the click put on the key. */
      const onKey = (key: number) => notesByName(doc).find((note) => note.key === key)
      // Shift and the wheel, as a browser on Windows may send it, down: across, the rows staying.
      expect(wheel({ shiftKey: true, deltaY: 2 * rollBar })).toBe(false)
      yield* drawn()
      click(0, 60)
      yield* drawn()
      expect(onKey(60)).toEqual({ track: 'Kick', tick: 2 * barTicks, key: 60, length: stepTicks })
      // A swipe sideways, back a bar; in lines, a step each.
      wheel({ deltaX: -rollBar })
      yield* drawn()
      wheel({ deltaX: 3, deltaMode: 1 })
      yield* drawn()
      click(0, 62)
      yield* drawn()
      expect(onKey(62)).toEqual({ track: 'Kick', tick: barTicks + 3 * stepTicks, key: 62, length: stepTicks })
      wheel({ deltaX: 10 ** 6 })
      yield* drawn()
      click(0, 64)
      yield* drawn()
      expect(onKey(64)).toEqual({ track: 'Kick', tick: 5 * barTicks, key: 64, length: stepTicks })
      // With Ctrl, as a trackpad's pinch comes: nowhere, and not the page's zoom.
      expect(wheel({ ctrlKey: true, deltaX: -rollBar, deltaY: 5 * rowHeight })).toBe(false)
      yield* drawn()
      click(0, 65)
      yield* drawn()
      expect(onKey(65)).toEqual({ track: 'Kick', tick: 5 * barTicks, key: 65, length: stepTicks })
      // A note held as the bars go by stays under the pointer.
      wheel({ deltaX: -4 * rollBar })
      yield* drawn()
      at('pointerdown', 0, 67)
      wheel({ deltaX: rollBar })
      yield* drawn()
      at('pointerup', 0, 67, { buttons: 0 })
      yield* drawn()
      expect(onKey(67)).toEqual({ track: 'Kick', tick: 2 * barTicks, key: 67, length: stepTicks })
      // Shorter, as far as it goes, the roll comes back to the bar after the end, and stays there as it grows again.
      wheel({ deltaX: 10 ** 6 })
      yield* drawn()
      eraseNotes(
        doc,
        elsewhere,
        clipOn(doc, 'Kick').id,
        kickNotes(doc)
          .filter(({ tick }) => tick > 2 * barTicks)
          .map(({ id }) => id)
      )
      yield* drawn()
      click(0, 69)
      yield* drawn()
      expect(onKey(69)).toEqual({ track: 'Kick', tick: 0, key: 69, length: stepTicks })
      noteElsewhere(doc, 'Kick', 8 * barSteps - 1, 40)
      yield* drawn()
      click(1, 70)
      yield* drawn()
      expect(onKey(70)).toEqual({ track: 'Kick', tick: stepTicks, key: 70, length: stepTicks })
      // A note held as the wheel turns past the end goes no further than the roll does.
      at('pointerdown', 0, 71)
      wheel({ deltaX: 10 ** 6 })
      yield* drawn()
      at('pointerup', 0, 71, { buttons: 0 })
      yield* drawn()
      expect(onKey(71)).toEqual({ track: 'Kick', tick: 5 * barTicks, key: 71, length: stepTicks })
    })
  ))

test('the piano roll follows the playhead to its bar as it starts to be heard and as it leaves; not once scrolled away, nor while a note is held', () =>
  page(({ doc, target, frame }) =>
    Effect.gen(function* () {
      // Sixteen bars long, in a roll four bars wide.
      noteElsewhere(doc, 'Kick', 16 * barSteps - 1, 40)
      yield* drawn()
      /** Where the click put the note of the key. */
      const tickOf = (key: number) => notesByName(doc).find((note) => note.key === key)?.tick
      // Opened while it plays: on the playhead's bar.
      yield* heardAt(frame, Option.some(2.5))
      yield* openKickClip(target)
      const { click, at, wheel } = yield* rollIn(target)
      yield* drawn(50)
      click(0, 60)
      yield* drawn()
      expect(tickOf(60)).toBe(2 * barTicks)
      // Past the right edge of the four bars shown: to the next.
      yield* heardAt(frame, Option.some(5.9))
      yield* heardAt(frame, Option.some(6))
      click(0, 61)
      yield* drawn()
      expect(tickOf(61)).toBe(6 * barTicks)
      // Round from the end of the loop to its start.
      yield* heardAt(frame, Option.some(9.5))
      yield* heardAt(frame, Option.some(0.25))
      click(0, 62)
      yield* drawn()
      expect(tickOf(62)).toBe(0)
      // Scrolled away from it: the roll stays where it was taken, the playhead leaving or coming in sight.
      wheel({ deltaX: 8 * rollBar })
      yield* drawn()
      yield* heardAt(frame, Option.some(3.9))
      yield* heardAt(frame, Option.some(4))
      click(0, 63)
      yield* drawn()
      expect(tickOf(63)).toBe(8 * barTicks)
      // In sight again, it leaves while a note is held: no jump under the pointer, nor once let go.
      yield* heardAt(frame, Option.some(11.9))
      at('pointerdown', 0, 64)
      yield* heardAt(frame, Option.some(12))
      at('pointerup', 0, 64, { buttons: 0 })
      yield* drawn()
      expect(tickOf(64)).toBe(8 * barTicks)
      yield* heardAt(frame, Option.some(12.5))
      click(0, 65)
      yield* drawn()
      expect(tickOf(65)).toBe(8 * barTicks)
      // Scrolled by hand in the frame the playhead leaves, as the scroll takes it out: the hand's, the roll staying.
      yield* heardAt(frame, Option.some(10.95))
      wheel({ deltaX: -(rollBar - rollBar / barSteps) })
      yield* heardAt(frame, Option.some(11.1))
      yield* heardAt(frame, Option.some(11.2))
      click(0, 69)
      yield* drawn()
      expect(tickOf(69)).toBe(7 * barTicks + stepTicks)
      // Back in sight, it leaves by itself as the wheel turns only the rows: the roll goes on with it.
      yield* heardAt(frame, Option.some(8.5))
      yield* heardAt(frame, Option.some(11))
      wheel({ deltaY: -rowHeight })
      yield* heardAt(frame, Option.some(11.1))
      click(0, 70)
      yield* drawn()
      expect(tickOf(70)).toBe(11 * barTicks)
      // Stopped, then played again: to the playhead's bar.
      yield* heardAt(frame, Option.none())
      yield* heardAt(frame, Option.some(3.5))
      click(0, 66)
      yield* drawn()
      expect(tickOf(66)).toBe(3 * barTicks)
      // As far as it goes already, short of the playhead's bar, it stays there as the pattern grows.
      wheel({ deltaX: 10 ** 6 })
      yield* heardAt(frame, Option.none())
      yield* heardAt(frame, Option.some(14.5))
      click(0, 67)
      yield* drawn()
      expect(tickOf(67)).toBe(13 * barTicks)
      noteElsewhere(doc, 'Kick', 24 * barSteps, 41)
      yield* drawn(50)
      click(0, 68)
      yield* drawn()
      expect(tickOf(68)).toBe(13 * barTicks)
    })
  ))

/** happy-dom's `ResizeObserver` tells nothing: one that tells the window's body of this class its size when asked. */
const resizes = (body: string) => {
  const told = new Set<() => void>()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private readonly tell: () => void) {}
      observe(element: Element) {
        Boolean.match(element.classList.contains(body), { onTrue: () => told.add(this.tell), onFalse: () => {} })
      }
      unobserve() {}
      disconnect() {
        told.delete(this.tell)
      }
    }
  )
  return () => told.forEach((tell) => tell())
}

test('the piano roll come forward from behind a tab while it plays goes to the playhead, as one opened would', () => {
  const resized = resizes('roll')
  return page(({ doc, target, frame }) =>
    Effect.gen(function* () {
      noteElsewhere(doc, 'Kick', 16 * barSteps - 1, 40)
      yield* drawn()
      yield* openKickClip(target)
      const { click } = yield* rollIn(target)
      yield* heardAt(frame, Option.some(0.5))
      rollBehindTab.now = true
      resized()
      yield* heardAt(frame, Option.some(5))
      yield* heardAt(frame, Option.some(6.5))
      rollBehindTab.now = false
      resized()
      yield* drawn(50)
      click(0, 60)
      yield* drawn()
      expect(notesByName(doc).find(({ key }) => key === 60)?.tick).toBe(6 * barTicks)
    })
  ).finally(() => {
    rollBehindTab.now = false
    vi.unstubAllGlobals()
  })
})

/** The note's velocity, as another client sets it: a note changes as a whole. */
const setVelocity = (doc: Y.Doc, id: string, velocity: number) =>
  doc.transact(() => {
    const notes = doc.getMap<object>(`notes/${clipOn(doc, 'Kick').pattern}`)
    notes.set(id, { ...notes.get(id), vel: velocity })
  })

test('a press on a key of the piano roll wakes the sound and plays it while held, the key under the pointer as it goes, and writes nothing', () => {
  const woken = { count: 0 }
  return page(
    ({ doc, target, auditions }) =>
      Effect.gen(function* () {
        yield* openKickClip(target)
        const { at, atPoint } = yield* rollIn(target)
        const kick = clipOn(doc, 'Kick').track
        const played = () => auditions().map(({ track, key, velocity }) => ({ track, key, velocity }))
        // Left of the first step: on the keyboard.
        expect(at('pointerdown', -1, 60)).toBe(false)
        yield* drawn()
        expect(played()).toEqual([{ track: kick, key: 60, velocity: 1 }])
        expect(woken.count).toBe(1)
        const [first] = auditions()
        at('pointermove', -1, 62, { button: -1 })
        yield* drawn()
        expect(played()).toEqual([{ track: kick, key: 62, velocity: 1 }])
        expect(auditions()[0].press).not.toBe(first.press)
        // Past the keyboard, the row's key; nothing put.
        at('pointermove', 4, 64, { button: -1 })
        yield* drawn()
        expect(played()).toEqual([{ track: kick, key: 64, velocity: 1 }])
        at('pointerup', 4, 64, { buttons: 0 })
        yield* drawn()
        expect(auditions()).toEqual([])
        expect(notesByName(doc)).toEqual([])
        // A right press on a key plays nothing, nor wakes the sound.
        at('pointerdown', -1, 60, { button: 2, buttons: 2 })
        yield* drawn()
        expect(auditions()).toEqual([])
        expect(woken.count).toBe(1)
        at('pointerup', -1, 60, { button: 2, buttons: 0 })
        // Right of C#3, the halves of its row are D3's above and C3's below, as drawn.
        const view: View = { width: 0, height: 0, top: 0, left: 0 }
        const beside = (part: number) => ({ x: keysWidth - 4, y: yOf(view, 61) + part * rowHeight })
        atPoint('pointerdown', beside(0.25))
        yield* drawn()
        expect(played()).toEqual([{ track: kick, key: 62, velocity: 1 }])
        atPoint('pointermove', beside(0.75))
        yield* drawn()
        expect(played()).toEqual([{ track: kick, key: 60, velocity: 1 }])
        // A press again on the key, its release unheard: played anew.
        const [held] = auditions()
        atPoint('pointerdown', beside(0.75))
        yield* drawn()
        expect(played()).toEqual([{ track: kick, key: 60, velocity: 1 }])
        expect(auditions()[0].press).not.toBe(held.press)
        // Down past the roll's lowest key in sight: no lower than it.
        atPoint('pointermove', { x: 4, y: rollSize.clientHeight + 50 * rowHeight })
        yield* drawn()
        expect(played()).toEqual([{ track: kick, key: 127 - 119, velocity: 1 }])
        atPoint('pointerup', { x: 4, y: rollSize.clientHeight }, 0)
        yield* drawn()
        expect(auditions()).toEqual([])
      }),
    {
      wake: Effect.sync(() => {
        woken.count += 1
      })
    }
  )
})

test('a key held in the piano roll sounds on the track its clip is moved to meanwhile', () =>
  page(({ doc, target, auditions }) =>
    Effect.gen(function* () {
      yield* openKickClip(target)
      const { at } = yield* rollIn(target)
      const { id, tick } = clipOn(doc, 'Kick')
      const [, snare] = readProject(doc).value.tracks
      at('pointerdown', -1, 60)
      yield* drawn()
      moveClip(doc, elsewhere, id, { track: snare.id, tick })
      yield* drawn()
      expect(auditions().map(({ track, key }) => ({ track, key }))).toEqual([{ track: snare.id, key: 60 }])
      at('pointerup', -1, 60, { buttons: 0 })
      yield* drawn()
      expect(auditions()).toEqual([])
    })
  ))

test('a note held in the piano roll plays where it is, as loud as it is, anew on another key only; erasing plays nothing', () =>
  page(({ doc, target, auditions }) =>
    Effect.gen(function* () {
      noteElsewhere(doc, 'Kick', 8, 67)
      setVelocity(doc, readProject(doc).value.patterns[0].notes[0].id, 0.5)
      yield* drawn()
      yield* openKickClip(target)
      const { at } = yield* rollIn(target)
      const played = () => auditions().map(({ key, velocity }) => ({ key, velocity }))
      // One put plays from the press, as loud as a step's.
      at('pointerdown', 0, 60)
      yield* drawn()
      expect(played()).toEqual([{ key: 60, velocity: 1 }])
      const [put] = auditions()
      // Later on its key, the same press; on another key, anew.
      at('pointermove', 3, 60, { button: -1 })
      yield* drawn()
      expect(auditions()).toEqual([put])
      at('pointermove', 3, 62, { button: -1 })
      yield* drawn()
      expect(played()).toEqual([{ key: 62, velocity: 1 }])
      at('pointerup', 3, 62, { buttons: 0 })
      yield* drawn()
      expect(auditions()).toEqual([])
      // A note pressed plays as loud as it is, and stops as it is let go of.
      at('pointerdown', 8, 67)
      yield* drawn()
      expect(played()).toEqual([{ key: 67, velocity: 0.5 }])
      at('pointerup', 8, 67, { buttons: 0 })
      yield* drawn()
      expect(auditions()).toEqual([])
      at('pointerdown', 8, 67, { button: 2, buttons: 2 })
      yield* drawn()
      expect(auditions()).toEqual([])
      at('pointerup', 8, 67, { button: 2, buttons: 0 })
    })
  ))

test('a key held in the piano roll is let go of as the roll closes', () =>
  page(({ target, auditions }) =>
    Effect.gen(function* () {
      yield* openKickClip(target)
      const { at } = yield* rollIn(target)
      at('pointerdown', -1, 60)
      yield* drawn()
      expect(auditions()).toHaveLength(1)
      yield* pressWindowButton(target, 'Piano roll')
      expect(auditions()).toEqual([])
    })
  ))

test('a note dragged back out of the last bar, the roll scrolled to the end, stays under the pointer until let go', () =>
  page(({ doc, target }) =>
    Effect.gen(function* () {
      // Eight bars long, in a roll four bars wide scrolled as far as it goes: bars six to nine.
      noteElsewhere(doc, 'Kick', 8 * barSteps - 1, 40)
      yield* drawn()
      yield* openKickClip(target)
      const { at, click, wheel } = yield* rollIn(target)
      wheel({ deltaX: 10 ** 6 })
      yield* drawn()
      at('pointerdown', 3 * barSteps - 1, 40)
      at('pointermove', 20, 40, { button: -1 })
      yield* drawn()
      at('pointermove', 20, 40, { button: -1 })
      yield* drawn()
      at('pointerup', 20, 40, { buttons: 0 })
      yield* drawn()
      expect(notesByName(doc)).toEqual([
        { track: 'Kick', tick: (5 * barSteps + 20) * stepTicks, key: 40, length: stepTicks }
      ])
      // Let go, the pattern shorter takes the roll back to the bar after its end.
      click(0, 60)
      yield* drawn()
      expect(notesByName(doc).find(({ key }) => key === 60)?.tick).toBe(4 * barTicks)
    })
  ))

test('a press in the piano roll is its own: no floating window takes it for a drag of the window', () =>
  page(({ doc, target }) =>
    Effect.gen(function* () {
      noteElsewhere(doc, 'Kick', 0, 60)
      yield* drawn()
      yield* openKickClip(target)
      const { at } = yield* rollIn(target)
      expect(at('pointerdown', 0, 60)).toBe(false)
      at('pointerup', 0, 60, { buttons: 0 })
      expect(at('pointerdown', 4, 60)).toBe(false)
      at('pointerup', 4, 60, { buttons: 0 })
      expect(at('pointerdown', 4, 60, { button: 2, buttons: 2 })).toBe(false)
      at('pointerup', 4, 60, { button: 2, buttons: 0 })
    })
  ))

test('a drag in the piano roll writes only what it changes: a length or a place another tab gives the note meanwhile stays', () =>
  page(({ doc, target }) =>
    Effect.gen(function* () {
      noteElsewhere(doc, 'Kick', 0, 60)
      yield* drawn()
      yield* openKickClip(target)
      const { at, drag } = yield* rollIn(target)
      const [{ id }] = readProject(doc).value.patterns[0].notes
      at('pointerdown', 0, 60)
      stretchNote(doc, elsewhere, clipOn(doc, 'Kick').id, id, 4 * stepTicks)
      at('pointermove', 2, 62, { button: -1 })
      at('pointerup', 2, 62, { buttons: 0 })
      yield* drawn()
      expect(notesByName(doc)).toEqual([{ track: 'Kick', tick: 2 * stepTicks, key: 62, length: 4 * stepTicks }])
      // By its right edge.
      at('pointerdown', 5.4, 62)
      moveNote(doc, elsewhere, clipOn(doc, 'Kick').id, id, { tick: Tick(8 * stepTicks), key: MidiKey(67) })
      at('pointermove', 6.4, 62, { button: -1 })
      at('pointerup', 6.4, 62, { buttons: 0 })
      yield* drawn()
      expect(notesByName(doc)).toEqual([{ track: 'Kick', tick: 8 * stepTicks, key: 67, length: 5 * stepTicks }])
      // A press alone writes nothing, though the note is two of different lengths, put by two tabs at once.
      const apart = new Y.Doc()
      Y.applyUpdate(apart, Y.encodeStateAsUpdate(doc))
      noteElsewhere(doc, 'Kick', 12, 70, 2)
      noteElsewhere(apart, 'Kick', 12, 70, 3)
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(apart))
      yield* drawn()
      expect(notesByName(doc).filter(({ key }) => key === 70)).toHaveLength(2)
      expect(updatesDuring(doc, () => drag([12, 70], [12.2, 70]))).toBe(0)
      expect(updatesDuring(doc, () => drag([13.4, 70], [13.3, 70]))).toBe(0)
    })
  ))

test('a press in the piano roll lets go of a drag whose release went unheard; one the browser cancels writes nothing', () =>
  page(({ doc, target, button }) =>
    Effect.gen(function* () {
      noteElsewhere(doc, 'Kick', 0, 60)
      yield* drawn()
      yield* openKickClip(target)
      const { at } = yield* rollIn(target)
      at('pointerdown', 0, 60)
      at('pointermove', 2, 60, { button: -1 })
      at('pointerdown', 6, 64, { pointerId: 2 })
      at('pointercancel', 6, 64, { pointerId: 2, buttons: 0 })
      yield* drawn()
      expect(notesByName(doc)).toEqual([{ track: 'Kick', tick: 2 * stepTicks, key: 60, length: stepTicks }])
      expect(button('Undo').disabled).toBe(false)
      at('pointerdown', 2, 60)
      at('pointermove', 5, 60, { button: -1 })
      at('pointercancel', 5, 60, { buttons: 0 })
      yield* drawn()
      expect(notesByName(doc)).toEqual([{ track: 'Kick', tick: 2 * stepTicks, key: 60, length: stepTicks }])
      expect(button('Undo').disabled).toBe(false)
    })
  ))

test('the cursor over the piano roll follows the notes under a still pointer, and shows nothing to move while erasing', () =>
  page(({ doc, target }) =>
    Effect.gen(function* () {
      noteElsewhere(doc, 'Kick', 0, 60)
      noteElsewhere(doc, 'Kick', 4, 60)
      yield* drawn()
      yield* openKickClip(target)
      const { roll, at } = yield* rollIn(target)
      at('pointermove', 0, 60, { button: -1, buttons: 0 })
      yield* drawn()
      expect(roll.dataset.grab).toBe('move')
      eraseNotes(
        doc,
        elsewhere,
        clipOn(doc, 'Kick').id,
        kickNotes(doc)
          .filter(({ tick }) => tick === 0)
          .map(({ id }) => id)
      )
      yield* drawn()
      expect(roll.dataset.grab).toBe('none')
      at('pointerdown', 4, 60, { button: 2, buttons: 2 })
      yield* drawn()
      expect(roll.dataset.grab).toBe('none')
      at('pointerup', 4, 60, { button: 2, buttons: 0 })
    })
  ))

test("a right click's menu, coming after its release as on Windows, erases nothing more than the press did", () =>
  page(({ doc, target }) =>
    Effect.gen(function* () {
      noteElsewhere(doc, 'Kick', 0, 60, 4)
      noteElsewhere(doc, 'Kick', 1, 60)
      yield* drawn()
      yield* openKickClip(target)
      const { at } = yield* rollIn(target)
      at('pointerdown', 1, 60, { button: 2, buttons: 2 })
      at('pointerup', 1, 60, { button: 2, buttons: 0 })
      expect(at('contextmenu', 1, 60, { button: 2, buttons: 0 })).toBe(false)
      yield* drawn()
      expect(notesByName(doc)).toHaveLength(1)
    })
  ))

test('a drag in the piano roll lets go where the page heard no release, and once its window turns away; one of a note erased writes nothing', () =>
  page(({ doc, target, button }) =>
    Effect.gen(function* () {
      noteElsewhere(doc, 'Kick', 0, 60)
      yield* drawn()
      yield* openKickClip(target)
      const { at } = yield* rollIn(target)
      at('pointerdown', 0, 60)
      at('pointermove', 3, 60, { button: -1 })
      at('pointermove', 5, 60, { button: -1, buttons: 0 })
      yield* drawn()
      expect(notesByName(doc)).toEqual([{ track: 'Kick', tick: 3 * stepTicks, key: 60, length: stepTicks }])
      expect(button('Undo').disabled).toBe(false)
      at('pointerdown', 3, 60)
      at('pointermove', 6, 60, { button: -1 })
      eraseNotes(
        doc,
        elsewhere,
        clipOn(doc, 'Kick').id,
        kickNotes(doc).map(({ id }) => id)
      )
      yield* drawn()
      expect(updatesDuring(doc, () => at('pointerup', 6, 60, { buttons: 0 }))).toBe(0)
      expect(notesByName(doc)).toEqual([])
      noteElsewhere(doc, 'Kick', 0, 60)
      yield* drawn()
      at('pointerdown', 0, 60)
      at('pointermove', 2, 60, { button: -1 })
      deleteTrack(doc, elsewhere, clipOn(doc, 'Kick').track)
      yield* drawn()
      expect(subOf(target, 'Piano roll')).toBe('No clip')
      // The buttons are drawn again once the roll that went has let go.
      yield* drawn()
      expect(button('Undo').disabled).toBe(false)
    })
  ))

test('the piano roll shows no clip once its clip is erased, and that one again as an undo brings it back', () =>
  page(({ doc, target }) =>
    Effect.gen(function* () {
      noteElsewhere(doc, 'Kick', 1, 64)
      yield* openKickClip(target)
      expect(subOf(target, 'Piano roll')).toBe('Kick')
      expect(target.querySelector('.roll')).not.toBeNull()
      const clip = clipOn(doc, 'Kick').id
      const map = Option.getOrThrow(
        Option.liftPredicate(doc.getMap('clips').get(clip), (found): found is Y.Map<unknown> => found instanceof Y.Map)
      )
      doc.transact(() => map.set('deleted', true), elsewhere)
      yield* drawn(50)
      expect(subOf(target, 'Piano roll')).toBe('No clip')
      expect(target.querySelector('.roll')).toBeNull()
      // Back, as another client's undo brings it.
      doc.transact(() => map.set('deleted', false), elsewhere)
      yield* drawn(50)
      expect(subOf(target, 'Piano roll')).toBe('Kick')
      expect(target.querySelector('.roll')).not.toBeNull()
    })
  ))

test('the layout keeps the clip open in the piano roll: opened again, it shows that one', () => {
  const views = memoryViews()
  const doc = projectDoc()
  return page(
    ({ target }) =>
      Effect.gen(function* () {
        yield* openKickClip(target)
        yield* saved
      }),
    {},
    {},
    { views, doc }
  ).then(() =>
    page(
      ({ target }) =>
        Effect.sync(() => {
          expect(windowsShown(target)).toEqual(['Arrangement', 'Piano roll'])
          expect(subOf(target, 'Piano roll')).toBe('Kick')
          expect(target.querySelector('.roll')).not.toBeNull()
        }),
      {},
      {},
      { views, doc }
    )
  )
})

test('the piano roll opened by its button shows no clip until a double click on one opens it there', () =>
  page(({ target }) =>
    Effect.gen(function* () {
      yield* pressWindowButton(target, 'Piano roll')
      expect(subOf(target, 'Piano roll')).toBe('No clip')
      expect(target.querySelector('.roll')).toBeNull()
      yield* openKickClip(target)
      expect(subOf(target, 'Piano roll')).toBe('Kick')
      expect(target.querySelector('.roll')).not.toBeNull()
    })
  ))

/** The Arrangement, scrolled to its first track and bar, and presses on it by bar and track's place. */
const arrangementIn = (target: HTMLElement) => {
  const arrangement = Option.getOrThrow(Option.fromNullishOr(target.querySelector<HTMLElement>('.arrangement__lanes')))
  const view: ArrangementView = { width: 0, height: 0, top: 0, left: 0, tracks: 0 }
  /** A press, a move or a release in the middle of the track's row in the bar, with this button. */
  const at = (
    type: string,
    bar: number,
    place: number,
    { button = 0, buttons = 1, ctrlKey = false, pointerId = 1 } = {}
  ) =>
    arrangement.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        button,
        buttons,
        ctrlKey,
        pointerId,
        clientX: arrangementXOf(view, (bar + 0.5) * barTicks),
        clientY: arrangementYOf(view, place) + trackHeight / 2
      })
    )
  const click = (bar: number, place: number) => {
    at('pointerdown', bar, place)
    at('pointerup', bar, place, { buttons: 0 })
  }
  /** Two clicks and the double click after them, as the browser sends them, in the middle of the track's row in the bar. */
  const doubleClick = (bar: number, place: number) => {
    click(bar, place)
    click(bar, place)
    arrangement.dispatchEvent(
      new MouseEvent('dblclick', {
        bubbles: true,
        cancelable: true,
        clientX: arrangementXOf(view, (bar + 0.5) * barTicks),
        clientY: arrangementYOf(view, place) + trackHeight / 2
      })
    )
  }
  /** A press, moves to each place after, and a release at the last, with this button. */
  const drag = (button: number, ...places: ReadonlyArray<readonly [bar: number, place: number]>) => {
    const [[bar, place], ...rest] = places
    const buttons = Boolean.match(button === 2, { onTrue: () => 2, onFalse: () => 1 })
    at('pointerdown', bar, place, { button, buttons })
    rest.forEach(([bar, place]) => at('pointermove', bar, place, { button: -1, buttons }))
    const [lastBar, lastPlace] = places[places.length - 1]
    at('pointerup', lastBar, lastPlace, { button, buttons: 0 })
  }
  /** The browser's menu asked for at the bar on the track, as a right click's release or Ctrl and a click on a Mac. */
  const menu = (bar: number, place: number) =>
    arrangement.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: arrangementXOf(view, (bar + 0.5) * barTicks),
        clientY: arrangementYOf(view, place) + trackHeight / 2
      })
    )
  const wheel = ({ shiftKey = false, ...init }: WheelEventInit) => {
    const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init })
    Object.defineProperty(event, 'shiftKey', { value: shiftKey })
    return arrangement.dispatchEvent(event)
  }
  return { at, click, doubleClick, drag, menu, wheel }
}

/** The Kick's clip, from the first bar on the first track, opened in the piano roll by a double click. */
const openKickClip = (target: HTMLElement) =>
  Effect.sync(() => arrangementIn(target).doubleClick(0, 0)).pipe(Effect.andThen(drawn(50)))

/** The project's clips, by ID, each by its track's name and its bar. */
const clipsOf = (doc: Y.Doc) => {
  const { tracks, clips } = readProject(doc).value
  return clips.map(({ track, tick }) => ({ track: tracks.find(({ id }) => id === track)?.name, bar: tick / barTicks }))
}

test("a double click on a track's row puts a clip of its own there from the bar and opens it; a drag moves it, to another track too; Cmd+Z takes each back", () =>
  page(
    ({ doc, target, button }) =>
      Effect.gen(function* () {
        const { at, click, doubleClick, drag } = arrangementIn(target)
        // A click alone puts nothing.
        click(1, 0)
        yield* drawn()
        expect(clipsOf(doc)).toEqual([])
        doubleClick(1, 0)
        yield* drawn(50)
        expect(clipsOf(doc)).toEqual([{ track: 'Kick', bar: 1 }])
        expect(subOf(target, 'Piano roll')).toBe('Kick')
        // None under the last track, and none of its own on one there.
        doubleClick(1, 2)
        doubleClick(1, 0)
        yield* drawn(50)
        expect(clipsOf(doc)).toEqual([{ track: 'Kick', bar: 1 }])
        // Held, it is where it was in the document.
        at('pointerdown', 1, 0)
        at('pointermove', 3, 1, { button: -1 })
        yield* drawn()
        expect(clipsOf(doc)).toEqual([{ track: 'Kick', bar: 1 }])
        at('pointerup', 3, 1, { buttons: 0 })
        yield* drawn()
        expect(clipsOf(doc)).toEqual([{ track: 'Snare', bar: 3 }])
        // Never before the first bar, above the first track or past the last.
        drag(0, [3, 1], [-3, -2])
        yield* drawn()
        expect(clipsOf(doc)).toEqual([{ track: 'Kick', bar: 0 }])
        drag(0, [0, 0], [0, 9])
        yield* drawn()
        expect(clipsOf(doc)).toEqual([{ track: 'Snare', bar: 0 }])
        button('Undo').click()
        yield* drawn()
        expect(clipsOf(doc)).toEqual([{ track: 'Kick', bar: 0 }])
        button('Undo').click()
        button('Undo').click()
        yield* drawn()
        expect(clipsOf(doc)).toEqual([{ track: 'Kick', bar: 1 }])
        button('Undo').click()
        yield* drawn()
        expect(clipsOf(doc)).toEqual([])
      }),
    {},
    {},
    { doc: tracksDoc() }
  ))

test("a clip's right edge dragged makes it shorter or longer by bars once let go, a press alone writing nothing; the cursor says so; Cmd+Z takes it back", () =>
  page(({ doc, target, button }) =>
    Effect.gen(function* () {
      const { at, click, drag } = arrangementIn(target)
      const arrangement = Option.getOrThrow(
        Option.fromNullishOr(target.querySelector<HTMLElement>('.arrangement__lanes'))
      )
      /** Each clip's own length in bars; none while it is as long as its pattern. */
      const ownBars = () =>
        readProject(doc).value.clips.map(({ ownLength }) => Option.map(ownLength, (length) => length / barTicks))
      // The Kick's, a bar long, as its pattern: 0.45 of a bar on, the press is 3 pixels in from its end, on its edge.
      const hover = (bar: number) => at('pointermove', bar, 0, { buttons: 0 })
      hover(0.45)
      yield* drawn()
      expect(arrangement.dataset.grab).toBe('resize')
      hover(0.2)
      yield* drawn()
      expect(arrangement.dataset.grab).toBe('move')
      hover(3)
      yield* drawn()
      expect(arrangement.dataset.grab).toBe('none')
      // Pressed and let go where it was: still as long as its pattern.
      click(0.45, 0)
      yield* drawn()
      expect(ownBars()).toEqual([Option.none()])
      // Held, it is as long as it was in the document; another track on the way changes nothing.
      at('pointerdown', 0.45, 0)
      at('pointermove', 2.45, 3, { button: -1 })
      yield* drawn()
      expect(arrangement.dataset.grab).toBe('resize')
      expect(ownBars()).toEqual([Option.none()])
      at('pointerup', 2.45, 3, { buttons: 0 })
      yield* drawn()
      expect(ownBars()).toEqual([Option.some(3)])
      expect(clipsOf(doc)).toEqual([{ track: 'Kick', bar: 0 }])
      // Shorter, no shorter than a bar.
      drag(0, [2.45, 0], [-5, 0])
      yield* drawn()
      expect(ownBars()).toEqual([Option.some(1)])
      button('Undo').click()
      yield* drawn()
      expect(ownBars()).toEqual([Option.some(3)])
      button('Undo').click()
      yield* drawn()
      expect(ownBars()).toEqual([Option.none()])
    })
  ))

test("a clip's edge let go writes its length though tracks went meanwhile, its own row with them", () => {
  const doc = tracksDoc()
  const [kick, snare] = readProject(doc).value.tracks
  addClip(doc, elsewhere, { track: snare.id, tick: Tick(0) })
  return page(
    ({ target }) =>
      Effect.gen(function* () {
        const { at } = arrangementIn(target)
        // On the Snare's row, the last; the Kick's going takes it up to the first.
        at('pointerdown', 0.45, 1)
        at('pointermove', 2.45, 1, { button: -1 })
        yield* drawn()
        deleteTrack(doc, elsewhere, kick.id)
        yield* drawn()
        at('pointerup', 2.45, 1, { buttons: 0 })
        yield* drawn()
        expect(
          readProject(doc).value.clips.map(({ ownLength }) => Option.map(ownLength, (length) => length / barTicks))
        ).toEqual([Option.some(3)])
      }),
    {},
    {},
    { doc }
  )
})

test("a clip's left edge dragged starts it later or earlier by bars once let go, its end where it was, from further into its pattern; Cmd+Z takes it back", () =>
  page(({ doc, target, button }) =>
    Effect.gen(function* () {
      const { at, drag } = arrangementIn(target)
      const arrangement = Option.getOrThrow(
        Option.fromNullishOr(target.querySelector<HTMLElement>('.arrangement__lanes'))
      )
      /** Each clip's start, own length and offset, in bars. */
      const spans = () =>
        readProject(doc).value.clips.map(({ tick, ownLength, offset }) => [
          tick / barTicks,
          Option.getOrUndefined(Option.map(ownLength, (length) => length / barTicks)),
          offset / barTicks
        ])
      // The Kick's from bar 2 to 5, of a pattern two bars long, by a note in its second bar: 0.05 of a bar in, the press
      // is 3 pixels in from its start.
      const clip = clipOn(doc, 'Kick')
      addNote(doc, elsewhere, clip.id, { tick: Tick(barTicks), key: MidiKey(60), length: 1 })
      expect(moveClip(doc, elsewhere, clip.id, { track: clip.track, tick: Tick(2 * barTicks) })).toBe(true)
      expect(resizeClip(doc, elsewhere, clip.id, 4 * barTicks)).toBe(true)
      yield* drawn()
      at('pointermove', 1.55, 0, { buttons: 0 })
      yield* drawn()
      expect(arrangement.dataset.grab).toBe('resize')
      // Later by a bar, on whatever track: three bars long, from its pattern's second bar.
      drag(0, [1.55, 0], [2.55, 4])
      yield* drawn()
      expect(spans()).toEqual([[3, 3, 1]])
      // Earlier, as far as the first bar: six bars long, the rounds where they were, from two bars before a round's start.
      drag(0, [2.55, 0], [-3, 0])
      yield* drawn()
      expect(spans()).toEqual([[0, 6, -2]])
      button('Undo').click()
      yield* drawn()
      expect(spans()).toEqual([[3, 3, 1]])
      button('Undo').click()
      yield* drawn()
      expect(spans()).toEqual([[2, 4, 0]])
    })
  ))

test('a double click on a clip opens it in the piano roll, and puts no clip; one on the heads puts none', () =>
  page(({ doc, grid, target }) =>
    Effect.gen(function* () {
      const { doubleClick } = arrangementIn(target)
      doubleClick(0, 0)
      yield* drawn(50)
      expect(clipsOf(doc)).toEqual([{ track: 'Kick', bar: 0 }])
      expect(windowsShown(target)).toEqual(['Arrangement', 'Piano roll'])
      expect(subOf(target, 'Piano roll')).toBe('Kick')
      grid.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: 10, clientY: 30 }))
      yield* drawn()
      expect(clipsOf(doc)).toHaveLength(1)
    })
  ))

/** How high the floating window that holds what the selector finds stands: the one raised last, the highest. */
const levelOf = (target: HTMLElement, selector: string) =>
  Number(target.querySelector(selector)?.closest('.dv-resize-container')?.getAttribute('aria-level'))

test('a press in a window brings it in front, as its button says; a clip opened again brings the piano roll back over it', () =>
  page(({ target }) =>
    Effect.gen(function* () {
      const { at, doubleClick } = arrangementIn(target)
      yield* openKickClip(target)
      expect(windowButton(target, 'Piano roll').dataset.hint).toContain('in front')
      // A press on the clip, as a drag's: its gesture keeps the focus where it was.
      at('pointerdown', 0, 0)
      at('pointerup', 0, 0, { buttons: 0 })
      yield* drawn()
      expect(windowButton(target, 'Arrangement').dataset.hint).toContain('in front')
      expect(levelOf(target, '.arrangement')).toBeGreaterThan(levelOf(target, '.roll'))
      doubleClick(0, 0)
      yield* drawn(50)
      expect(windowButton(target, 'Piano roll').dataset.hint).toContain('in front')
      expect(levelOf(target, '.roll')).toBeGreaterThan(levelOf(target, '.arrangement'))
    })
  ))

test('a right click erases a clip, a drag with it all it passes over as one step, and so does Ctrl and a click on a Mac', () => {
  const doc = manyTracksDoc(4)
  readProject(doc).value.tracks.forEach(({ id }) => addClip(doc, elsewhere, { track: id, tick: Tick(0) }))
  return page(
    ({ target, button }) =>
      Effect.gen(function* () {
        const { at, drag, menu } = arrangementIn(target)
        drag(2, [0, 0], [0, 1], [0, 2])
        // The menu a right click's release asks for erases no more.
        menu(0, 3)
        yield* drawn()
        expect(clipsOf(doc).map(({ track }) => track)).toEqual(['Synth 2'])
        button('Undo').click()
        yield* drawn()
        expect(clipsOf(doc)).toHaveLength(4)
        // Ctrl and a press is no click yet; the menu it asks for erases.
        at('pointerdown', 0, 3, { ctrlKey: true })
        at('pointerup', 0, 3, { buttons: 0, ctrlKey: true })
        expect(clipsOf(doc)).toHaveLength(4)
        menu(0, 3)
        yield* drawn()
        expect(
          clipsOf(doc)
            .map(({ track }) => track)
            .toSorted()
        ).toEqual(['Kick', 'Snare', 'Synth'])
      }),
    {},
    {},
    { doc }
  )
})

test('the wheel goes through the tracks, and Shift and the wheel through the bars, as far as the last clip', () => {
  const doc = manyTracksDoc(20)
  addClip(doc, elsewhere, { track: readProject(doc).value.tracks[0].id, tick: Tick(20 * barTicks) })
  return page(
    ({ target }) =>
      Effect.gen(function* () {
        const { doubleClick, wheel } = arrangementIn(target)
        // Each in a task of its own, as the browser sends them: the page draws between them.
        expect(wheel({ deltaY: 3 * trackHeight, deltaMode: 0 })).toBe(false)
        yield* drawn()
        expect(wheel({ deltaY: 2, deltaMode: 1 })).toBe(false)
        yield* drawn()
        // Past the last clip's end, as far as it, at the heads.
        expect(wheel({ deltaY: 100 * barWidth, deltaMode: 0, shiftKey: true })).toBe(false)
        yield* drawn()
        doubleClick(0, 0)
        yield* drawn()
        expect(clipsOf(doc)).toContainEqual({ track: trackAt(doc, 5), bar: 21 })
      }),
    {},
    {},
    { doc }
  )
})

test('the Arrangement scrolled down stays where tracks taken away took it back, as tracks put later come', () => {
  const doc = manyTracksDoc(20)
  return page(
    ({ target }) =>
      Effect.gen(function* () {
        const { doubleClick, wheel } = arrangementIn(target)
        wheel({ deltaY: 100 * trackHeight, deltaMode: 0 })
        yield* drawn()
        // All but three gone, all in sight from the first; as many put again, below them.
        readProject(doc)
          .value.tracks.slice(3)
          .forEach(({ id }) => deleteTrack(doc, elsewhere, id))
        yield* drawn()
        Array.from({ length: 17 }).forEach(() => addTrack(doc, elsewhere))
        yield* drawn()
        doubleClick(0, 0)
        yield* drawn()
        expect(clipsOf(doc)).toEqual([{ track: trackAt(doc, 0), bar: 0 }])
      }),
    {},
    {},
    { doc }
  )
})

/** The bar the clip on the track at the place starts at: a double click at the Arrangement's left puts it on the bar shown there. */
const barOnTrack = (doc: Y.Doc, place: number) => clipsOf(doc).find((clip) => clip.track === trackAt(doc, place))?.bar

test('the Arrangement follows the playhead to its bar as it starts to be heard and as it leaves; not once scrolled away, nor while a clip is held', () => {
  // Twenty-four bars long, in an Arrangement eight bars wide and ten tracks high: the last clip on a track below.
  const doc = manyTracksDoc(20)
  addClip(doc, elsewhere, { track: readProject(doc).value.tracks[19].id, tick: Tick(23 * barTicks) })
  return page(
    ({ target, frame }) =>
      Effect.gen(function* () {
        const { at, doubleClick, wheel } = arrangementIn(target)
        const arrangementAt = (bars: Option.Option<number>) => heardAt(frame, bars)
        /** The bar shown at the Arrangement's left, as a double click there puts a clip on the track at the place. */
        const leftOn = (place: number) =>
          Effect.gen(function* () {
            doubleClick(0, place)
            yield* drawn()
            return barOnTrack(doc, place)
          })
        yield* arrangementAt(Option.some(10.5))
        expect(yield* leftOn(0)).toBe(10)
        // Past the right edge of the eight bars shown: to the next.
        yield* arrangementAt(Option.some(17.9))
        yield* arrangementAt(Option.some(18))
        expect(yield* leftOn(1)).toBe(18)
        // Round from the end of the arrangement to its start.
        yield* arrangementAt(Option.some(23.5))
        yield* arrangementAt(Option.some(0.25))
        expect(yield* leftOn(2)).toBe(0)
        // Scrolled away from it: the Arrangement stays where it was taken, the playhead leaving or coming in sight.
        expect(wheel({ deltaY: 8 * barWidth, deltaMode: 0, shiftKey: true })).toBe(false)
        yield* arrangementAt(Option.some(6.9))
        yield* arrangementAt(Option.some(7))
        expect(yield* leftOn(3)).toBe(8)
        // In sight again, it leaves while a clip is held: no jump under the pointer, nor once let go.
        yield* arrangementAt(Option.some(15.9))
        at('pointerdown', 0, 3)
        yield* arrangementAt(Option.some(16))
        at('pointerup', 0, 3, { buttons: 0 })
        yield* drawn()
        expect(barOnTrack(doc, 3)).toBe(8)
        yield* arrangementAt(Option.some(16.5))
        expect(yield* leftOn(4)).toBe(8)
        // Scrolled by hand in the frame the playhead leaves, as the scroll takes it out: the hand's, the Arrangement
        // staying.
        yield* arrangementAt(Option.some(14.45))
        expect(wheel({ deltaX: -1.5 * barWidth, deltaMode: 0 })).toBe(false)
        yield* arrangementAt(Option.some(14.6))
        yield* arrangementAt(Option.some(14.7))
        expect(yield* leftOn(5)).toBe(7)
        // Stopped, then played again: to the playhead's bar.
        yield* arrangementAt(Option.none())
        yield* arrangementAt(Option.some(3.5))
        expect(yield* leftOn(6)).toBe(3)
      }),
    {},
    {},
    { doc }
  )
})

test('the Arrangement come forward from behind a tab while the arrangement plays goes to the playhead, as one opened would', () => {
  const resized = resizes('arrangement')
  const doc = manyTracksDoc(10)
  addClip(doc, elsewhere, { track: readProject(doc).value.tracks[9].id, tick: Tick(23 * barTicks) })
  return page(
    ({ target, frame }) =>
      Effect.gen(function* () {
        yield* heardAt(frame, Option.some(0.5))
        arrangementBehindTab.now = true
        resized()
        yield* heardAt(frame, Option.some(5))
        yield* heardAt(frame, Option.some(12.5))
        arrangementBehindTab.now = false
        resized()
        yield* drawn(50)
        arrangementIn(target).doubleClick(0, 0)
        yield* drawn()
        expect(barOnTrack(doc, 0)).toBe(12)
      }),
    {},
    {},
    { doc }
  ).finally(() => {
    arrangementBehindTab.now = false
    vi.unstubAllGlobals()
  })
})

/** happy-dom draws on no canvas: one whose drawing is the rectangles filled on each canvas since it was last cleared. */
const fillsOnCanvases = () => {
  const filled = new Map<HTMLCanvasElement, Array<readonly [x: number, y: number, width: number, height: number]>>()
  const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
    this: HTMLCanvasElement
  ) {
    const canvas = this
    const drawing: Record<string, (...args: ReadonlyArray<number>) => void> = {
      clearRect: () => filled.set(canvas, []),
      fillRect: (x = 0, y = 0, width = 0, height = 0) => filled.get(canvas)?.push([x, y, width, height])
    }
    return new Proxy(
      {},
      { get: (_, name) => drawing[String(name)] ?? (() => {}), set: () => true }
    ) as CanvasRenderingContext2D
  } as never)
  return {
    filled: (canvas: HTMLCanvasElement | undefined) =>
      Option.fromUndefinedOr(canvas).pipe(Option.flatMap((on) => Option.fromUndefinedOr(filled.get(on)))),
    restore: () => spy.mockRestore()
  }
}

/** The next animation frame the page draws, and what the page draws on before the browser shows it. */
const oneFrame = Effect.callback<void>((resume) => {
  requestAnimationFrame(() => resume(Effect.void))
})

test('the Arrangement gone on to the playhead shows it in the frame it goes in, on the bars it went to', () => {
  const canvases = fillsOnCanvases()
  const doc = projectDoc()
  addClip(doc, elsewhere, { track: readProject(doc).value.tracks[1].id, tick: Tick(23 * barTicks) })
  return page(
    ({ target, frame }) =>
      Effect.gen(function* () {
        yield* heardAt(frame, Option.some(9.9))
        frame.current = {
          engine: 1,
          telemetry: undefined,
          heard: { tick: 17.25 * barTicks, loop: 16 * barTicks },
          stats: undefined
        }
        yield* oneFrame
        // Gone on to the bar it is in: a quarter of the bar in.
        const line = (x: number, y: number, width: number) =>
          x === headsWidth + barWidth / 4 && y === arrangementRulerHeight && width === 1
        expect(
          Option.exists(
            canvases.filled(target.querySelectorAll<HTMLCanvasElement>('.arrangement canvas')[3]),
            (rects) => rects.some(([x, y, width]) => line(x, y, width))
          )
        ).toBe(true)
      }),
    {},
    {},
    { doc }
  ).finally(canvases.restore)
})

test('a clip longer than its pattern has a line in it where the pattern starts again, in sight', () => {
  const canvases = fillsOnCanvases()
  return page(({ doc, target }) =>
    Effect.gen(function* () {
      expect(resizeClip(doc, elsewhere, clipOn(doc, 'Kick').id, 3 * barTicks)).toBe(true)
      yield* drawn()
      // A bar of the pattern each: the lines at the second and third bars, none at its end.
      const lines = Option.map(
        canvases.filled(target.querySelectorAll<HTMLCanvasElement>('.arrangement canvas')[1]),
        (rects) => rects.filter(([, , width]) => width === 1).map(([x, y, , height]) => [x, y, height])
      )
      const y = arrangementRulerHeight + 5
      expect(lines).toEqual(
        Option.some([
          [headsWidth + barWidth, y, trackHeight - 11],
          [headsWidth + 2 * barWidth, y, trackHeight - 11]
        ])
      )
    })
  ).finally(canvases.restore)
})

test('a clip started inside its pattern has its lines where the pattern starts again, after its start', () => {
  const canvases = fillsOnCanvases()
  return page(({ doc, target }) =>
    Effect.gen(function* () {
      // A pattern two bars long, by a note in its second bar; the clip from bar 2, three bars long, from the pattern's
      // second bar: an offset past the period goes round it, as another client may write it.
      const clip = clipOn(doc, 'Kick').id
      addNote(doc, elsewhere, clip, { tick: Tick(barTicks), key: MidiKey(60), length: 1 })
      const span = { tick: Tick(2 * barTicks), length: 3 * barTicks, offset: 3 * barTicks }
      expect(trimClip(doc, elsewhere, clip, span)).toBe(true)
      yield* drawn()
      const lines = Option.map(
        canvases.filled(target.querySelectorAll<HTMLCanvasElement>('.arrangement canvas')[1]),
        (rects) => rects.filter(([, , width]) => width === 1).map(([x]) => x)
      )
      // The second round from its second bar, none before it: one line.
      expect(lines).toEqual(Option.some([headsWidth + 3 * barWidth]))
    })
  ).finally(canvases.restore)
})

test('on a desk with no room for them, as before it is laid out, the windows open no smaller than the least', () =>
  page(({ target }) =>
    Effect.sync(() => {
      // happy-dom lays out no desk: it has no room at all.
      const sizes = Array.from(target.querySelectorAll<HTMLElement>('.dv-resize-container')).map((box) => [
        box.querySelector('.dock-tab__title')?.textContent,
        box.style.width,
        box.style.height
      ])
      expect(sizes).toEqual([['Arrangement', '240px', '160px']])
    })
  ))
