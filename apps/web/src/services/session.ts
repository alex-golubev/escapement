import {
  batchedState,
  byContent,
  currentPatternOf,
  followProject,
  type Holds,
  type HoldTarget,
  heardOf,
  heldOver,
  heldValue,
  type Id,
  isStepNote,
  patternEnd,
  type Listening,
  type Note,
  newWriter,
  noHolds,
  noAuditions,
  newListening,
  type Pattern,
  type PlayMode,
  type Audition,
  type Auditions,
  type ProjectAtoms,
  stepTicks,
  toggledMode,
  type Writer
} from '@escapement/model'
import { Context, Effect, Layer, Option } from 'effect'
import { Atom, AtomRegistry } from 'effect/reactivity'
import type * as Y from 'yjs'
import { type Loaded, type ProjectStorage, ProjectStore, type Stopped } from './project-store'
import { manifestChannels } from './samples'

/** The project the page opened: its ID, and its name in the list. */
export class OpenedProject extends Context.Service<OpenedProject, { readonly id: Id; readonly name: string }>()(
  'OpenedProject'
) {}

/** How the saved project stands. */
export type Saving = Loaded | Stopped

/** The project the page edits, and how this client listens to it, as long as the page is open. */
export interface ProjectSession {
  readonly doc: Y.Doc
  /** This page's mark on what it writes: its undo takes back only that. */
  readonly writer: Writer
  readonly project: ProjectAtoms
  /** This page's own: it lasts as long as the page, and not past a reload. */
  readonly listening: Atom.Writable<Listening>
  /** The controls this page turns now, also its own. */
  readonly holds: Atom.Writable<Holds>
  /** The notes this page plays by hand now, to hear them, also its own. */
  readonly auditions: Atom.Writable<Auditions>
  /** Plays the note by hand until the function it gives lets go of it. */
  readonly audition: (note: Omit<Audition, 'press'>) => () => void
  /** The controls the project's other tabs turn now, as their presence tells. */
  readonly heldElsewhere: Atom.Writable<Holds>
  /** What plays over the document's: this page's holds, and the other tabs' of the controls it doesn't turn. */
  readonly played: Atom.Atom<Holds>
  /** The value played for the control over the document's; none while no one turns it. */
  readonly held: (target: HoldTarget) => Atom.Atom<Option.Option<number>>
  /** The channels heard now, by the project and this client's listening. */
  readonly heard: Atom.Atom<ReadonlyArray<Id>>
  /** The ID of the current pattern, as this page chooses it among the live ones: the one seen and played. */
  readonly pattern: Atom.Atom<Option.Option<Id>>
  /** The current pattern, none without one. */
  readonly currentPattern: Atom.Atom<Option.Option<Pattern>>
  /** The name of the current pattern, none without one. */
  readonly patternName: Atom.Atom<Option.Option<string>>
  /** How long the current pattern plays: `patternEnd`, a bar without one. */
  readonly patternEnd: Atom.Atom<number>
  /** Makes the pattern current on this page. */
  readonly choosePattern: (pattern: Id) => void
  /** What Play plays on this page: the current pattern or the arrangement. */
  readonly mode: Atom.Atom<PlayMode>
  readonly chooseMode: (mode: PlayMode) => void
  /** Arrangement after Pattern, Pattern after Arrangement, as L switches. */
  readonly toggleMode: () => void
  /** Whether the current pattern has a note of the channel on the step. */
  readonly step: (channel: Id, step: number) => Atom.Atom<boolean>
  /** The channel's notes in the current pattern, by ID; none without one. */
  readonly notes: (channel: Id) => Atom.Atom<ReadonlyArray<Note>>
  /** Whether steps show all the channel's notes: each is one a step switched on would make. */
  readonly showsSteps: (channel: Id) => Atom.Atom<boolean>
  /** How long the current pattern would be by the notes of every live channel but this one: `patternEnd`. */
  readonly endWithout: (channel: Id) => Atom.Atom<number>
  readonly saving: Atom.Atom<Saving>
  /** Makes the browser refuse a write, so the page's recovery can be checked. */
  readonly breakSaving: Effect.Effect<void>
}

export const ProjectSession = Context.Service<ProjectSession>('ProjectSession')

/** The session of the project in the storage that `writer` edits. */
export const sessionOf = Effect.fnUntraced(function* (
  { doc, loaded, stopped, breakSaving }: ProjectStorage,
  writer: Writer
) {
  const registry = yield* AtomRegistry.AtomRegistry
  const project = yield* followProject(doc)
  // The compiler reads these by more than one way.
  const listening = batchedState<Listening>(newListening)
  const holds = batchedState<Holds>(noHolds)
  const heldElsewhere = batchedState<Holds>(noHolds)
  const auditions = batchedState<Auditions>(noAuditions)
  // Each press a number of its own, below 2^31 as the engine takes them.
  const presses = { next: 0 }
  const played = byContent((get) => heldOver(get(holds), get(heldElsewhere)))
  const saving = Atom.make<Saving>(loaded).pipe(Atom.keepAlive)
  yield* Effect.forkScoped(Effect.flatMap(stopped, (why) => Effect.sync(() => registry.set(saving, why))))
  const current = currentPatternOf(project, listening)
  const currentPattern = current.pattern
  const notes = Atom.family((channel: Id) =>
    byContent((get) =>
      Option.match(get(currentPattern), {
        onNone: () => [],
        onSome: (pattern) => pattern.notes.filter((note) => note.channel === channel)
      })
    )
  )
  // Read again only as the channel's notes change, and then each step's only a look up: an edit elsewhere costs none.
  const ticks = Atom.family((channel: Id) =>
    Atom.map(notes(channel), (them) => new Set<number>(them.map(({ tick }) => tick)))
  )
  const step = Atom.family((channel: Id) =>
    Atom.family((at: number) => Atom.map(ticks(channel), (them) => them.has(at * stepTicks)))
  )
  const session: ProjectSession = {
    doc,
    writer,
    project,
    listening,
    holds,
    auditions,
    audition: (note) => {
      const press = presses.next
      presses.next = (press + 1) % 2 ** 31
      registry.update(auditions, (now) => [...now, { ...note, press }])
      return () => registry.update(auditions, (now) => now.filter((played) => played.press !== press))
    },
    heldElsewhere,
    played,
    held: Atom.family((target: HoldTarget) => byContent((get) => heldValue(get(played), target))),
    heard: heardOf(project, listening),
    pattern: current.id,
    currentPattern,
    patternName: byContent((get) => Option.map(get(currentPattern), ({ name }) => name)),
    patternEnd: current.end,
    choosePattern: (chosen) => registry.update(listening, (now) => ({ ...now, pattern: Option.some(chosen) })),
    mode: byContent((get) => get(listening).mode),
    chooseMode: (mode) => registry.update(listening, (now) => ({ ...now, mode })),
    toggleMode: () => registry.update(listening, toggledMode),
    step: (channel, at) => step(channel)(at),
    notes,
    showsSteps: Atom.family((channel: Id) => byContent((get) => get(notes(channel)).every(isStepNote))),
    endWithout: Atom.family((channel: Id) =>
      byContent((get) => {
        const others = new Set(get(project.channelIds).filter((id) => id !== channel))
        return patternEnd(
          Option.match(get(currentPattern), {
            onNone: () => [],
            onSome: ({ notes }) => notes.filter((note) => others.has(note.channel))
          })
        )
      })
    ),
    saving,
    breakSaving
  }
  return session
})

/** The project the page opened, as this browser keeps it; if it doesn't, a new one, unsaved. */
export const projectSessionLayer = Layer.effect(
  ProjectSession,
  Effect.gen(function* () {
    const { id } = yield* OpenedProject
    const writer = newWriter('page')
    const storage = yield* (yield* ProjectStore).open(id, writer, manifestChannels)
    return yield* sessionOf(storage, writer)
  })
)
