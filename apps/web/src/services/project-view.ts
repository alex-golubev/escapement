import { byContent, type Id, type ProjectAtoms } from '@escapement/model'
import { Boolean, Context, Effect, Equal, FiberSet, Layer, Option } from 'effect'
import { Atom, AtomRegistry } from 'effect/reactivity'
import { ProjectSession } from './session'
import {
  type Centre,
  centresFor,
  firstView,
  type PanelHeight,
  type Scroll,
  Shown,
  type View,
  ViewStore
} from './view-store'

/** How this page shows the project, its own as solo is, kept for the project with each change. */
export interface ProjectView {
  /** What the middle can show in this build, in the order of its buttons. */
  readonly centres: ReadonlyArray<Centre>
  /** What the middle shows: one saved that this build hasn't, the first it has. */
  readonly centre: Atom.Atom<Centre>
  /** What the panel shows, while it is live: none before anything is, and while it is gone. */
  readonly below: Atom.Atom<Option.Option<Shown>>
  /** The track chosen: the one the panel shows, or the one whose clip's notes it does. */
  readonly track: Atom.Atom<Option.Option<Id>>
  readonly isChosen: (track: Id) => Atom.Atom<boolean>
  /** Whether the panel shows the notes of a clip on the track. */
  readonly hasNotesBelow: (track: Id) => Atom.Atom<boolean>
  /** The clip whose notes the panel shows. */
  readonly clip: Atom.Atom<Option.Option<Id>>
  readonly turnTo: (centre: Centre) => void
  /** The track shown in the panel, unfolded: as a click on its name does, and + for the track it adds. */
  readonly show: (track: Id) => void
  /** The clip's notes shown in the panel, unfolded: as a double click on it does. */
  readonly open: (clip: Id) => void
  /** How high the panel is, as the page lays it out. */
  readonly panel: Atom.Atom<PanelHeight>
  /** The panel folded to its title, or unfolded to the share it had. */
  readonly fold: (folded: boolean) => void
  /** The panel as its border left it: as high as `share`, or folded, keeping the share it had to unfold to. */
  readonly resized: (share: number, folded: boolean) => void
  /** How far the Arrangement is scrolled, in pixels: kept as the middle shows another, written once it stands. */
  readonly arrangementScroll: { readonly down: Atom.Writable<number>; readonly across: Atom.Writable<number> }
  /** How far the mixer's rack is scrolled across, in pixels: kept as the Arrangement's is. */
  readonly rackScroll: Atom.Writable<number>
}

export const ProjectView = Context.Service<ProjectView>('ProjectView')

/** How long a scroll stands still before it is written: scrolling moves it many times a second. */
const scrollStands = '300 millis'

/** The project's view as `store` saved it, or a new project's, written as it changes: the scroll once it stands. */
export const projectViewOf = Effect.fnUntraced(function* (
  store: ViewStore,
  project: ProjectAtoms,
  centres: ReadonlyArray<Centre>
) {
  const registry = yield* AtomRegistry.AtomRegistry
  const { scroll: scrolledFrom, ...shownFrom } = Option.getOrElse(store.saved, () => firstView)
  const state = Atom.make<Omit<View, 'scroll'>>(shownFrom).pipe(
    Atom.withEquality<Omit<View, 'scroll'>>(Equal.equals),
    Atom.keepAlive
  )
  const scrolledTo = (start: number) => Atom.make(start).pipe(Atom.keepAlive)
  const arrangementScroll = {
    down: scrolledTo(scrolledFrom.arrangement.down),
    across: scrolledTo(scrolledFrom.arrangement.across)
  }
  const rackScroll = scrolledTo(scrolledFrom.rack)
  const stood = Atom.make(
    (get): Scroll => ({
      arrangement: { down: get(arrangementScroll.down), across: get(arrangementScroll.across) },
      rack: get(rackScroll)
    })
  ).pipe(Atom.debounce(scrollStands))
  // Set to what it already is, it writes nothing.
  const kept = Atom.make((get): View => ({ ...get(state), scroll: get(stood) })).pipe(
    Atom.withEquality<View>(Equal.equals)
  )
  const runFork = yield* FiberSet.makeRuntime<never>()
  yield* Effect.acquireRelease(
    Effect.sync(() => registry.subscribe(kept, (view) => void runFork(store.save(view)))),
    (unsubscribe) => Effect.sync(unsubscribe)
  )
  // Gone, none, and back with an undo, it again.
  const below = byContent((get) =>
    Option.filter(get(state).below, (shown) =>
      Shown.match(shown, {
        Track: ({ track }) => Option.isSome(get(project.track(track))),
        Notes: ({ clip }) => Option.isSome(get(project.clip(clip)))
      })
    )
  ).pipe(Atom.keepAlive)
  const clip = byContent((get) =>
    Option.flatMap(get(below), (shown) =>
      Shown.match(shown, { Track: () => Option.none(), Notes: ({ clip }) => Option.some(clip) })
    )
  ).pipe(Atom.keepAlive)
  const clipTrack = byContent((get) =>
    Option.flatMap(get(clip), (id) => Option.map(get(project.clip(id)), (found) => found.track))
  )
  const track = byContent((get) =>
    Option.flatMap(get(below), (shown) =>
      Shown.match(shown, { Track: ({ track }) => Option.some(track), Notes: () => get(clipTrack) })
    )
  ).pipe(Atom.keepAlive)
  const placing = (place: (panel: PanelHeight) => PanelHeight) =>
    registry.update(state, (view) => ({ ...view, panel: place(view.panel) }))
  const showing = (shown: Shown) =>
    registry.update(state, (view) => ({ ...view, below: Option.some(shown), panel: { ...view.panel, folded: false } }))
  const view: ProjectView = {
    centres,
    centre: byContent((get) =>
      Option.getOrElse(
        Option.liftPredicate(get(state).centre, (centre) => centres.includes(centre)),
        () => centres[0]
      )
    ).pipe(Atom.keepAlive),
    below,
    track,
    isChosen: Atom.family((id: Id) => byContent((get) => Option.contains(get(track), id))),
    hasNotesBelow: Atom.family((id: Id) => byContent((get) => Option.contains(get(clipTrack), id))),
    clip,
    turnTo: (centre) => registry.update(state, (view) => ({ ...view, centre })),
    show: (id) => showing({ _tag: 'Track', track: id }),
    open: (id) => showing({ _tag: 'Notes', clip: id }),
    panel: byContent((get) => get(state).panel).pipe(Atom.keepAlive),
    fold: (folded) => placing((panel) => ({ ...panel, folded })),
    resized: (share, folded) =>
      placing((panel) =>
        Boolean.match(folded, { onTrue: () => ({ ...panel, folded }), onFalse: () => ({ share, folded }) })
      ),
    arrangementScroll,
    rackScroll
  }
  return view
})

export const projectViewLayer = Layer.effect(
  ProjectView,
  Effect.gen(function* () {
    const session = yield* ProjectSession
    return yield* projectViewOf(yield* ViewStore, session.project, centresFor(import.meta.env.DEV))
  })
)
