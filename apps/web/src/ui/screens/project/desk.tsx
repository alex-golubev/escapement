import {
  type AddPanelPositionOptions,
  type DockviewApi,
  type DockviewGroupPanel,
  type DockviewPanelApi,
  DockviewReact,
  type DockviewReadyEvent,
  type DockviewTheme,
  type IDockviewPanel,
  type IDockviewPanelHeaderProps,
  type IDockviewPanelProps,
  type SerializedDockview
} from 'dockview-react'
import 'dockview-react/dist/styles/dockview.css'
import { useAtomValue } from '@effect/atom-react'
import { byContent, type Id, barSteps, storedId } from '@escapement/model'
import { Array, Boolean, Effect, Equal, Option, Record, Result, Schema } from 'effect'
import { Atom } from 'effect/reactivity'
import { type ComponentChildren, createContext, type FunctionComponent } from 'preact'
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks'
import { useCore } from '../../core-context'
import { type Axes, bothAxes, fittedSize, outgrown, type Size } from '../../kit/fit'
import { PianoRollContext, type PianoRollWindow } from '../../parts/piano-roll-window'
import { type TrackWindows, TrackWindowsContext } from '../../parts/track-windows'
import { WindowBodyContext } from '../../parts/window-body'
import { Arrangement } from '../../windows/arrangement/arrangement'
import { headsWidth } from '../../windows/arrangement/layout'
import { DebugPanel } from '../../windows/debug-panel/debug-panel'
import { Mixer } from '../../windows/mixer/mixer'
import { keysWidth, stepWidth } from '../../windows/piano-roll/layout'
import { PianoRoll, PianoRollName } from '../../windows/piano-roll/piano-roll'
import { TrackSettings, useInstrumentName, useTrackName } from '../../windows/track/track'
import './desk.css'

/**
 * A window the desk can hold: its title, what stands beside the title, its body, where it first opens, whether only a
 * build for development has its button, and whether it is fitted to what is in it or what is in it fills it.
 */
interface WindowKind {
  readonly title: string
  readonly devOnly: boolean
  readonly fits: boolean
  readonly Sub: FunctionComponent
  readonly Body: FunctionComponent
  readonly first: { readonly left: number; readonly top: number; readonly width: number; readonly height: number }
}

const nothing = () => null

/** Room kept between a window and the desk's edges, and between the windows a new project opens with. */
const margin = 16

/** A window's body pads what is in it by this on each side. */
const bodyPadding = 8

/** How far down the desk a window opens over the lower part of the Arrangement, its first tracks left in sight. */
const lowerTop = 284

/** Right of the tracks' heads, so a window opened from one leaves them in sight. */
const pastHeads = margin + headsWidth + 2 * bodyPadding + margin

const windows = {
  // The main window: all of the desk.
  arrangement: {
    title: 'Arrangement',
    devOnly: false,
    fits: false,
    Sub: nothing,
    Body: Arrangement,
    first: { left: margin, top: margin, width: Number.POSITIVE_INFINITY, height: Number.POSITIVE_INFINITY }
  },
  // Over the Arrangement's lower part, right of its heads: a bar of steps beside the keyboard.
  'piano-roll': {
    title: 'Piano roll',
    devOnly: false,
    fits: false,
    Sub: PianoRollName,
    Body: PianoRoll,
    first: {
      left: pastHeads,
      top: lowerTop,
      width: keysWidth + barSteps * stepWidth + 2 * bodyPadding,
      height: 360
    }
  },
  // Along the top right of the heads, so they stay in sight, as wide as the desk leaves room for and as high as a strip;
  // its inserts scroll across.
  mixer: {
    title: 'Mixer',
    devOnly: false,
    fits: false,
    Sub: nothing,
    Body: Mixer,
    first: { left: pastHeads, top: margin, width: Number.POSITIVE_INFINITY, height: 470 }
  },
  // A tool for development: the sound's numbers, and buttons that break things on purpose.
  debug: {
    title: 'Debug',
    devOnly: true,
    fits: true,
    Sub: nothing,
    Body: DebugPanel,
    first: { left: margin, top: lowerTop, width: 520, height: 300 }
  }
} satisfies Record<string, WindowKind>

export type WindowName = keyof typeof windows

export const windowNames = Record.keys(windows)

/**
 * The windows the desk holds, each with a button on the transport bar: the project's main ones, few of them. A track's
 * window opens from its head, an effect's from its slot. A tool for development only in a build for it: elsewhere a
 * saved layout that holds it isn't taken.
 */
export const deskWindows = (development: boolean) => windowNames.filter((name) => development || !windows[name].devOnly)

/** What a new project opens with: the Arrangement; the others wait for their buttons, the piano roll for a clip. */
const firstOpen: ReadonlyArray<WindowName> = ['arrangement']

const kindOf = (name: string) => Record.get<string, WindowKind>(windows, name)

/** The piano roll's window, of which there is one. */
const pianoRoll: WindowName = 'piano-roll'

/** What the piano roll's layout keeps of the clip last opened in it. */
const rollParams = (chosen: Option.Option<Id>) =>
  Option.match(chosen, { onNone: () => ({}), onSome: (clip) => ({ clip }) })

/** The clip the piano roll's layout keeps, read as any saved layout may hold it. */
const clipOf = Schema.decodeUnknownOption(Schema.Struct({ clip: storedId }))

/** A track's window keeps the track it is of in its layout, read as any saved layout may hold it. */
const trackOf = Schema.decodeUnknownOption(Schema.Struct({ track: storedId }))

/** Of its own for each track, and never a main window's name. */
const trackWindowId = (track: Id) => `track:${track}`

/** What the dock draws a track's window with. */
const trackComponent = 'track'

/**
 * Right of the tracks' heads, along the top, before it is fitted to what is in it: from the top, an instrument's
 * controls have the desk's height.
 */
const trackFirst = { left: pastHeads, top: margin, width: 240, height: 200 }

/** How far down and right of the window in front one opened beside it stands. */
const besideStep = 24

/** The size the browser has laid `element` out at, in whole pixels up, so nothing is cut; none before layout. */
const laidOut = (element: HTMLElement) =>
  Option.liftPredicate(element.getBoundingClientRect(), (box) => box.width > 0).pipe(
    Option.map((box) => ({ width: Math.ceil(box.width), height: Math.ceil(box.height) }))
  )

/** The padding of `element`, none if the browser can't tell. */
const paddingOf = (element: HTMLElement) =>
  Option.getOrElse(
    Option.liftPredicate(Number.parseFloat(getComputedStyle(element).paddingTop), Number.isFinite),
    () => 0
  )

/** Where a group stands on the desk, if it floats. */
const floatingBox = (group: DockviewGroupPanel) =>
  Option.filter(Option.fromNullishOr(group.api.boundingBox), () => group.api.location.type === 'floating')

/** Floating where `box` stands. */
const floatingAt = (box: WindowKind['first']) =>
  ({ floating: { position: { left: box.left, top: box.top }, width: box.width, height: box.height } }) as const

/** The least a window opens at, however small the desk, or before it is laid out. */
const leastHeight = 160
const leastWidth = 240

/** Where the window first opens: no wider and no lower than the desk's margin. */
const placeOf = (dock: DockviewApi, { first }: WindowKind) => ({
  ...first,
  width: Math.max(Math.min(first.width, dock.width - first.left - margin), leastWidth),
  height: Math.max(Math.min(first.height, dock.height - first.top - margin), leastHeight)
})

/**
 * The floating window `panel` is in, sized along `along` to what is in its body, its padding even on every side, as far
 * as the desk allows: across, as wide as the desk; one too wide for the room right of it the dock slides left, up to the
 * desk's edge. The body's outer size counts a scroll bar, and the content's box holds its children's margins.
 */
const fitWindow = (dock: DockviewApi, panel: DockviewPanelApi, body: HTMLElement, content: HTMLElement, along: Axes) =>
  Option.match(
    Option.all({
      box: floatingBox(panel.group),
      size: laidOut(content)
    }),
    {
      onNone: () => false,
      onSome: ({ box, size }) => {
        const fitted = fittedSize({
          window: box,
          body: { width: body.offsetWidth, height: body.offsetHeight },
          padding: paddingOf(body),
          content: size,
          room: { width: dock.width - 2 * margin, height: dock.height - box.top - margin }
        })
        panel.group.api.setSize({
          width: Boolean.match(along.width, { onTrue: () => fitted.width, onFalse: () => box.width }),
          height: Boolean.match(along.height, { onTrue: () => fitted.height, onFalse: () => box.height })
        })
        return true
      }
    }
  )

const theme: DockviewTheme = { name: 'escapement', className: 'dockview-theme-escapement', colorScheme: 'dark', gap: 8 }

/** What the desk and the windows on it share with the provider. */
interface Desking {
  /** Hands over the dock once the desk is ready. */
  readonly ready: (api: DockviewApi) => void
  /** Opens a window floating where it first opens, to be fitted to what is in it once drawn. */
  readonly open: (api: DockviewApi, name: WindowName) => void
  /** Whether the window, by its ID, was just opened, not restored: it is fitted once, then no more. */
  readonly takeFit: (id: string) => boolean
  /** Keeps the layout now, as after a change the dock doesn't tell of. */
  readonly saveNow: (api: DockviewApi) => void
}

const DeskingContext = createContext<Desking>({
  ready: () => {},
  open: () => {},
  takeFit: () => false,
  saveNow: () => {}
})

/**
 * A window's body, named for screen readers, in a padded frame that scrolls what doesn't fit. Just opened, it fits
 * its window to what is in it before the browser shows it; a window restored keeps the size it was left at.
 */
const WindowFrame = ({
  api,
  containerApi,
  label,
  children
}: Pick<IDockviewPanelProps, 'api' | 'containerApi'> & {
  readonly label: string
  readonly children: ComponentChildren
}) => {
  const { takeFit, saveNow } = useContext(DeskingContext)
  const body = useRef<HTMLElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const was = useRef(Option.none<Size>())
  useLayoutEffect(
    () =>
      Option.match(
        Option.all({ body: Option.fromNullishOr(body.current), content: Option.fromNullishOr(content.current) }),
        {
          onNone: () => {},
          onSome: (drawn) => {
            const fit = (along: Axes) =>
              Boolean.match(fitWindow(containerApi, api, drawn.body, drawn.content, along), {
                // Resizing a floating window tells the dock's layout nothing.
                onTrue: () => saveNow(containerApi),
                onFalse: () => {}
              })
            Boolean.match(takeFit(api.id), { onTrue: () => fit(bothAxes), onFalse: () => {} })
            was.current = laidOut(drawn.content)
            // Grown along a side it showed all of what is in it along, it goes on showing it all, such as with a
            // track added. A frame later: resizing the window inside the observer's turn would resize the dock's
            // parts it watches too, past what the turn can tell.
            const frames = new Set<number>()
            const observer = new ResizeObserver(() => {
              const now = laidOut(drawn.content)
              const along = Option.match(Option.all({ was: was.current, now }), {
                onNone: () => ({ width: false, height: false }),
                onSome: (sizes) =>
                  outgrown({
                    // Outer: a scroll bar the growth brings shouldn't count against the size that showed it all.
                    body: { width: drawn.body.offsetWidth, height: drawn.body.offsetHeight },
                    padding: paddingOf(drawn.body),
                    ...sizes
                  })
              })
              was.current = now
              Boolean.match(along.width || along.height, {
                onTrue: () => {
                  const frame = requestAnimationFrame(() => {
                    frames.delete(frame)
                    fit(along)
                  })
                  frames.add(frame)
                },
                onFalse: () => {}
              })
            })
            observer.observe(drawn.content)
            return () => {
              observer.disconnect()
              frames.forEach(cancelAnimationFrame)
            }
          }
        }
      ),
    []
  )
  return (
    <section class='dock-body' ref={body} aria-label={label}>
      <div class='dock-fit' ref={content}>
        <WindowBodyContext.Provider value={body}>{children}</WindowBodyContext.Provider>
      </div>
    </section>
  )
}

/** A body that fills its window, as the piano roll's grid does: the window isn't fitted to it. */
const FillFrame = ({ label, children }: { readonly label: string; readonly children: ComponentChildren }) => (
  <section class='dock-body dock-body--fill' aria-label={label}>
    {children}
  </section>
)

const bodies = Record.map(windows, ({ title, Body, fits }: WindowKind) =>
  Boolean.match(fits, {
    onTrue: () => (props: IDockviewPanelProps) => (
      <WindowFrame api={props.api} containerApi={props.containerApi} label={title}>
        <Body />
      </WindowFrame>
    ),
    onFalse: () => () => (
      <FillFrame label={title}>
        <Body />
      </FillFrame>
    )
  })
)

const TrackFrame = ({
  api,
  containerApi,
  track
}: Pick<IDockviewPanelProps, 'api' | 'containerApi'> & { readonly track: Id }) => {
  const name = useTrackName(track)
  // The dock names the window by it to screen readers, as it renames.
  useEffect(() => api.setTitle(name), [api, name])
  return (
    <WindowFrame api={api} containerApi={containerApi} label={name}>
      <TrackSettings track={track} />
    </WindowFrame>
  )
}

/** A track's window; one whose layout names no track draws nothing. */
const TrackWindow = ({ api, containerApi, params }: IDockviewPanelProps) =>
  Option.match(trackOf(params), {
    onNone: nothing,
    onSome: ({ track }) => <TrackFrame api={api} containerApi={containerApi} track={track} />
  })

const hintOf = (title: string) =>
  `${title}: yours alone, as you lay the windows out. Drag the tab onto an edge or another window to dock it; a floating window moves by the strip above it`

/** A window's tab: its title, what stands beside it, and a close button; `reopen` says how it opens again. */
const WindowTab = ({
  api,
  title,
  sub,
  reopen
}: {
  readonly api: DockviewPanelApi
  readonly title: string
  readonly sub: ComponentChildren
  readonly reopen: string
}) => (
  <div class='dock-tab' data-hint={hintOf(title)}>
    <span class='dock-tab__title'>{title}</span>
    <span class='dock-tab__sub'>{sub}</span>
    <button
      type='button'
      class='dock-tab__close'
      aria-label={`Close ${title}`}
      data-hint={`Close ${title}; ${reopen}`}
      // A press here, by mouse, pen or touch, doesn't start a drag of the tab.
      onPointerDown={(event) => {
        event.preventDefault()
        event.stopPropagation()
      }}
      onClick={() => api.close()}
    >
      <svg viewBox='0 0 12 12' aria-hidden='true'>
        <path d='M3.5 3.5l5 5M8.5 3.5l-5 5' />
      </svg>
    </button>
  </div>
)

/** A track's window's tab: the track's name, and what plays it. */
const TrackTab = ({ api, track }: { readonly api: DockviewPanelApi; readonly track: Id }) => (
  <WindowTab
    api={api}
    title={useTrackName(track)}
    sub={useInstrumentName(track)}
    reopen='a click on its name in its head in the Arrangement opens it again'
  />
)

const Tab = ({ api, params }: IDockviewPanelHeaderProps) =>
  Option.match(kindOf(api.id), {
    onSome: ({ title, Sub }) => (
      <WindowTab api={api} title={title} sub={<Sub />} reopen='its button on the transport bar opens it again' />
    ),
    onNone: () =>
      Option.match(trackOf(params), {
        onNone: nothing,
        onSome: ({ track }) => <TrackTab api={api} track={track} />
      })
  })

/** The windows in sight now, the one in front, and the tracks whose windows are in sight. */
interface Sight {
  readonly shown: ReadonlyArray<WindowName>
  readonly front: Option.Option<WindowName>
  readonly tracks: ReadonlyArray<Id>
}

const noSight: Sight = { shown: [], front: Option.none(), tracks: [] }

/** How the windows stand, read only by what shows it, and the press of a window's button. */
interface Dock {
  readonly sight: Atom.Atom<Sight>
  /** Closes the window in front; brings an open one forward; opens a closed one where it first opens. */
  readonly toggle: (name: WindowName) => void
}

const DockContext = createContext<Dock>({ sight: Atom.make(noSight), toggle: () => {} })

export const useDock = () => useContext(DockContext)

const panelOf = (api: DockviewApi, name: WindowName) => Option.fromNullishOr(api.getPanel(name))

/** Open and not behind another tab of its group. */
const shownOf = (api: DockviewApi) =>
  windowNames.filter((name) => Option.exists(panelOf(api, name), (panel) => panel.api.isVisible))

/** The window whose group is active, and in front of its tabs. */
const frontOf = (api: DockviewApi) =>
  Option.filter(
    Option.flatMap(Option.fromNullishOr(api.activePanel), (panel) =>
      kindOf(panel.id).pipe(Option.as(panel.id as WindowName))
    ),
    (name) => Option.exists(panelOf(api, name), (panel) => panel.api.isVisible)
  )

const sameNames = Array.makeEquivalence<WindowName>((a, b) => a === b)

/** The tracks' windows on the desk, of a track or not, as a saved layout may hold them. */
const trackWindowsOf = (api: DockviewApi) => api.panels.filter((panel) => panel.api.component === trackComponent)

/** The track of each of its windows in sight: not behind another tab of its group. */
const tracksShownOf = (api: DockviewApi) =>
  trackWindowsOf(api).flatMap((panel) =>
    Option.toArray(
      Option.map(
        Option.filter(trackOf(panel.params), () => panel.api.isVisible),
        ({ track }) => track
      )
    )
  )

/** A step down and right of the floating track window last turned to, or where a track's window first opens. */
const besideOf = (open: ReadonlyArray<IDockviewPanel>) =>
  Option.match(Array.last(Array.getSomes(open.map(({ group }) => floatingBox(group)))), {
    onNone: () => trackFirst,
    onSome: (box) => ({ ...trackFirst, left: box.left + besideStep, top: box.top + besideStep })
  })

const sightOf = (api: DockviewApi): Sight => ({
  shown: shownOf(api),
  front: frontOf(api),
  tracks: tracksShownOf(api)
})

const sameTracks = Array.makeEquivalence<Id>((a, b) => a === b)

/** The same windows in sight and in front, as through most of a drag. */
const sameSight = (was: Sight, now: Sight) =>
  sameNames(was.shown, now.shown) && Equal.equals(was.front, now.front) && sameTracks(was.tracks, now.tracks)

/**
 * The windows' state for whatever draws inside: the desk hands over its dock, the transport bar's buttons open,
 * bring forward and close windows on it. Each change of the layout is kept for the project.
 */
export const DockProvider = ({ children }: { readonly children: ComponentChildren }) => {
  const { view, run, registry, session } = useCore()
  const [dock, setDock] = useState(Option.none<DockviewApi>())
  // In an atom, not state: a change draws the buttons that show it, not everything under the provider.
  const sight = useMemo(() => Atom.make(noSight).pipe(Atom.keepAlive), [])
  /** Windows opened and not yet drawn, by ID, to be fitted once they are. */
  const toFit = useRef(new Set<string>())
  /** Track windows by ID, the one last turned to last: a click on a name takes the focus to the Arrangement. */
  const turnedTo = useRef<ReadonlyArray<string>>([])
  useEffect(
    () =>
      Option.match(dock, {
        onNone: () => undefined,
        onSome: (api) => {
          const follow = () =>
            registry.update(sight, (was) => {
              const now = sightOf(api)
              // A drag's many moves leave the windows as they stood: their buttons aren't drawn again.
              return Boolean.match(sameSight(was, now), { onTrue: () => was, onFalse: () => now })
            })
          const listening = api.onDidLayoutChange(({ reasons }) => {
            follow()
            // Read as the write starts: a drag's many moves make one layout.
            run(view.saveLayout(() => api.toJSON(), { now: reasons.has('structure') }))
          })
          const activating = api.onDidActivePanelChange(({ panel }) =>
            Option.map(
              Option.filter(Option.fromNullishOr(panel), (active) => active.api.component === trackComponent),
              ({ id }) => {
                turnedTo.current = [...turnedTo.current.filter((was) => was !== id), id]
              }
            )
          )
          follow()
          return () => {
            listening.dispose()
            activating.dispose()
          }
        }
      }),
    [dock, view, run, registry, sight]
  )
  // A track no longer there takes its window with it, a window a saved layout holds too.
  useEffect(
    () =>
      Option.match(dock, {
        onNone: () => undefined,
        onSome: (api) =>
          registry.subscribe(
            session.project.trackIds,
            (ids) =>
              trackWindowsOf(api)
                .filter((panel) => !Option.exists(trackOf(panel.params), ({ track }) => ids.includes(track)))
                .forEach((panel) => panel.api.close()),
            { immediate: true }
          )
      }),
    [dock, registry, session]
  )
  const open = useCallback((api: DockviewApi, name: WindowName) => {
    const kind: WindowKind = windows[name]
    Boolean.match(kind.fits, { onTrue: () => void toFit.current.add(name), onFalse: () => {} })
    api.addPanel({ id: name, component: name, title: kind.title, ...floatingAt(placeOf(api, kind)) })
  }, [])
  const desking = useMemo<Desking>(
    () => ({
      ready: (api) => setDock(Option.some(api)),
      open,
      takeFit: (name) => toFit.current.delete(name),
      saveNow: (api) => run(view.saveLayout(() => api.toJSON(), { now: true }))
    }),
    [open, view, run]
  )
  // A click on a track's name: its window in sight closes, one behind a tab comes forward, and a closed one opens in
  // place of the track window last turned to, if it is in sight, the others closing, or beside it.
  const toggleTrack = useCallback<TrackWindows['toggle']>(
    (track, alongside) =>
      Option.match(dock, {
        onNone: () => {},
        onSome: (api) => {
          const id = trackWindowId(track)
          const openAt = (place: ReturnType<typeof floatingAt> | { readonly position: AddPanelPositionOptions }) => {
            toFit.current.add(id)
            api.addPanel({ id, component: trackComponent, params: { track }, ...place })
          }
          Option.match(Option.fromNullishOr(api.getPanel(id)), {
            onSome: (panel) =>
              Boolean.match(panel.api.isVisible, {
                onTrue: () => panel.api.close(),
                onFalse: () => panel.api.setActive()
              }),
            onNone: () => {
              const rank = (panel: IDockviewPanel) => turnedTo.current.indexOf(panel.id)
              // The ones never turned to first, as the dock holds them.
              const open = trackWindowsOf(api).toSorted((a, b) => rank(a) - rank(b))
              Boolean.match(alongside, {
                onTrue: () => openAt(floatingAt(besideOf(open))),
                onFalse: () => {
                  openAt(
                    Option.match(
                      Array.findLast(open, (panel) => panel.api.isVisible),
                      {
                        onNone: () => floatingAt(trackFirst),
                        onSome: (shown) => ({ position: { referenceGroup: shown.group } })
                      }
                    )
                  )
                  open.forEach((panel) => panel.api.close())
                }
              })
            }
          })
        }
      }),
    [dock]
  )
  const isShown = useMemo(
    () => Atom.family((track: Id) => Atom.map(sight, ({ tracks }) => tracks.includes(track))),
    [sight]
  )
  const trackWindows = useMemo(() => ({ toggle: toggleTrack, isShown }), [toggleTrack, isShown])
  /** The clip last opened in the piano roll, as its layout keeps it. */
  const chosen = useMemo(() => Atom.make(Option.none<Id>()).pipe(Atom.keepAlive), [])
  // The one chosen while it is live: gone, nothing, and back with an undo, it again.
  const shownInRoll = useMemo(
    () =>
      byContent((get) => Option.filter(get(chosen), (clip) => Option.isSome(get(session.project.clip(clip))))).pipe(
        Atom.keepAlive
      ),
    [chosen, session]
  )
  // The layout keeps the clip the piano roll shows: read from it once restored, written into it as it changes.
  useEffect(
    () =>
      Option.match(dock, {
        onNone: () => undefined,
        onSome: (api) => {
          registry.set(
            chosen,
            Option.flatMap(panelOf(api, pianoRoll), (panel) => Option.map(clipOf(panel.params), ({ clip }) => clip))
          )
          const keep = (panel: IDockviewPanel) => {
            panel.api.updateParameters(rollParams(registry.get(chosen)))
            run(view.saveLayout(() => api.toJSON(), { now: true }))
          }
          const adding = api.onDidAddPanel((panel) =>
            Option.map(
              Option.liftPredicate(panel, ({ id }) => id === pianoRoll),
              keep
            )
          )
          const changing = registry.subscribe(chosen, () => Option.map(panelOf(api, pianoRoll), keep))
          return () => {
            adding.dispose()
            changing()
          }
        }
      }),
    [dock, registry, chosen, run, view]
  )
  // From a double click on a clip: the piano roll opens on it, or turns to it and comes forward.
  const showInRoll = useCallback(
    (clip: Id) => {
      registry.set(chosen, Option.some(clip))
      Option.map(dock, (api) =>
        Option.match(panelOf(api, pianoRoll), {
          onNone: () => open(api, pianoRoll),
          onSome: (panel) => panel.api.setActive()
        })
      )
    },
    [registry, chosen, dock, open]
  )
  const roll = useMemo<PianoRollWindow>(() => ({ show: showInRoll, clip: shownInRoll }), [showInRoll, shownInRoll])
  // A window's button brings it forward first, and closes it once it is in front.
  const toggle = useCallback(
    (name: WindowName) =>
      Option.match(dock, {
        onNone: () => {},
        onSome: (api) =>
          Option.match(panelOf(api, name), {
            onNone: () => open(api, name),
            onSome: (panel) =>
              Boolean.match(Option.contains(frontOf(api), name), {
                onTrue: () => panel.api.close(),
                onFalse: () => panel.api.setActive()
              })
          })
      }),
    [dock, open]
  )
  const value = useMemo(() => ({ sight, toggle }), [sight, toggle])
  return (
    <DockContext.Provider value={value}>
      <TrackWindowsContext.Provider value={trackWindows}>
        <PianoRollContext.Provider value={roll}>
          <DeskingContext.Provider value={desking}>{children}</DeskingContext.Provider>
        </PianoRollContext.Provider>
      </TrackWindowsContext.Provider>
    </DockContext.Provider>
  )
}

/**
 * The window pressed made the active one: the dock raises a floating window at any press in it, but makes it active
 * only as the focus goes into it, which a gesture's press keeps out. So the window on top is the one called in front.
 */
const activateUnder = (api: DockviewApi, target: EventTarget | null) =>
  Option.map(
    Array.findFirst(api.groups, (group) => target instanceof Node && group.element.contains(target)),
    (group) => group.api.setActive()
  )

/** The desk with the windows on it: as saved for the project, if the dock takes it, or as a new project opens. */
export const Desk = () => {
  const { view, run } = useCore()
  const { ready, open } = useContext(DeskingContext)
  const docked = useRef(Option.none<DockviewApi>())
  const components = useMemo(() => {
    const held = deskWindows(import.meta.env.DEV)
    return { ...Record.filter(bodies, (_, name) => Array.contains(held, name)), [trackComponent]: TrackWindow }
  }, [])
  const onReady = ({ api }: DockviewReadyEvent) => {
    // The dock checks what it reads, and throws on what it can't take.
    const restored = Option.map(view.layout, (layout) => Result.try(() => api.fromJSON(layout as SerializedDockview)))
    Option.match(Option.flatMap(restored, Result.getFailure), {
      onNone: () => {},
      onSome: (error) => run(Effect.logWarning("The saved layout couldn't be restored", error))
    })
    Boolean.match(Option.exists(restored, Result.isSuccess), {
      onTrue: () => {},
      onFalse: () => {
        api.clear()
        firstOpen.forEach((name) => open(api, name))
      }
    })
    docked.current = Option.some(api)
    ready(api)
  }
  return (
    <main
      class='desk'
      aria-label='Windows'
      onPointerDownCapture={(event) => Option.map(docked.current, (api) => activateUnder(api, event.target))}
    >
      <DockviewReact
        components={components}
        defaultTabComponent={Tab}
        watermarkComponent={nothing}
        theme={theme}
        floatingGroupBounds='boundedWithinViewport'
        floatingGroupDragHandle='titlebar'
        onReady={onReady}
      />
    </main>
  )
}

/** A button on the transport bar for each main window, lit while the window is in sight. */
export const WindowButtons = () => {
  const { sight, toggle } = useDock()
  const { shown, front } = useAtomValue(sight)
  return Array.map(deskWindows(import.meta.env.DEV), (name) => {
    const { title } = windows[name]
    const inSight = shown.includes(name)
    const hint = Boolean.match(Option.contains(front, name), {
      onTrue: () => `${title} is in front: a click closes it`,
      onFalse: () =>
        Boolean.match(inSight, {
          onTrue: () => `${title} is open: a click brings it forward`,
          onFalse: () => `Show ${title}`
        })
    })
    return (
      <button
        key={name}
        type='button'
        class='btn btn--window'
        aria-pressed={inSight}
        data-hint={`${hint}. The windows are yours alone, as you lay them out`}
        onClick={() => toggle(name)}
      >
        {title}
      </button>
    )
  })
}
