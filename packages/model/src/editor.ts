import type { ParamId, Plugin, StripParamId } from '@escapement/engine-description'
import { Effect, Option } from 'effect'
import { Atom, AtomRegistry } from 'effect/reactivity'
import * as Y from 'yjs'
import type { Id } from './id'
import {
  addClip,
  addNote,
  addTrack,
  type ClipPlace,
  type ClipSpan,
  deleteTrack,
  eraseClips,
  eraseNotes,
  moveClip,
  moveNote,
  type NewInstrument,
  type NewNote,
  renameTrack,
  resizeClip,
  setMasterParam,
  setMasterStrip,
  setMute,
  setTempo,
  setTrackColour,
  setTrackParam,
  setTrackStrip,
  stretchNote,
  trimClip
} from './operations'
import type { Writer } from './writer'

/**
 * A writer's edits of one document, each a step of its history, which takes back the writer's own changes and no one
 * else's. Each edit returns false if what it acts on isn't there.
 */
export interface Editor {
  /** Of the clip's pattern, as the clip's notes are. */
  readonly addNote: (clip: Id, note: NewNote) => boolean
  readonly moveNote: (clip: Id, note: Id, to: Pick<NewNote, 'tick' | 'key'>) => boolean
  readonly stretchNote: (clip: Id, note: Id, length: number) => boolean
  readonly eraseNotes: (clip: Id, notes: ReadonlyArray<Id>) => boolean
  readonly setMute: (track: Id, mute: boolean) => boolean
  readonly setTrackParam: (track: Id, param: ParamId<Plugin>, value: number) => boolean
  readonly setTrackStrip: (track: Id, param: StripParamId, value: number) => boolean
  readonly setMasterParam: (slot: Id, param: ParamId<Plugin>, value: number) => boolean
  readonly setMasterStrip: (param: StripParamId, value: number) => boolean
  readonly setTempo: (bpm: number) => boolean
  /** The new track's ID, a synth's unless another instrument is given; none if the document holds no project. */
  readonly addTrack: (instrument?: NewInstrument) => Option.Option<Id>
  readonly renameTrack: (track: Id, name: string) => boolean
  /** False if refused: not `#rrggbb` in lower case, or a track not live. */
  readonly setTrackColour: (track: Id, colour: string) => boolean
  readonly deleteTrack: (track: Id) => boolean
  /** The new clip's ID; none if the track isn't live, or the tick isn't a whole one of the engine's. */
  readonly addClip: (place: ClipPlace) => Option.Option<Id>
  readonly moveClip: (clip: Id, to: ClipPlace) => boolean
  /** False if refused: a length not whole, under a tick or ending too late, or a clip not live. */
  readonly resizeClip: (clip: Id, length: number) => boolean
  /** False if refused: a span out of range, or a clip not live. */
  readonly trimClip: (clip: Id, span: ClipSpan) => boolean
  readonly eraseClips: (clips: ReadonlyArray<Id>) => boolean
  /**
   * Opens an action, such as a turn from press to release: until every open one ends, what is written is one step,
   * and undo and redo do nothing. Returns its end; only the first call ends it.
   */
  readonly begin: () => () => void
  /** Takes back the last step that still changes something; false if none does, or an action is open. */
  readonly undo: () => boolean
  readonly redo: () => boolean
  readonly canUndo: Atom.Atom<boolean>
  readonly canRedo: Atom.Atom<boolean>
}

/** The writer's editor of `doc` while the scope is open; what it wrote before isn't in the history. */
export const editorOf = Effect.fnUntraced(function* (doc: Y.Doc, by: Writer) {
  const registry = yield* AtomRegistry.AtomRegistry
  const canUndo = Atom.make(false).pipe(Atom.keepAlive)
  const canRedo = Atom.make(false).pipe(Atom.keepAlive)
  const manager = yield* Effect.acquireRelease(
    // No time window: a step is an action, however far apart its changes. The whole document, as each pattern's notes
    // are a map of its top; only what changes something, as a scope of maps would take: an undo that finds nothing
    // left to change is no step to redo.
    Effect.sync(
      () =>
        new Y.UndoManager(doc, {
          captureTransaction: ({ changed }) => changed.size > 0,
          trackedOrigins: new Set([by]),
          captureTimeout: Number.POSITIVE_INFINITY
        })
    ),
    (manager) => Effect.sync(() => manager.destroy())
  )
  const open = new Set<object>()
  // The stacks change in a transaction: an edit, or an undo or redo, even one that finds nothing left to change.
  const stacksChanged = () =>
    Atom.batch(() => {
      registry.set(canUndo, open.size === 0 && manager.canUndo())
      registry.set(canRedo, open.size === 0 && manager.canRedo())
    })
  yield* Effect.acquireRelease(
    Effect.sync(() => doc.on('afterTransaction', stacksChanged)),
    () => Effect.sync(() => doc.off('afterTransaction', stacksChanged))
  )
  /** With no action open, a step starts here. */
  const nextStep = () => {
    // biome-ignore lint/plugin/control-flow: Yjs's undo manager, plain JS
    if (open.size === 0) manager.stopCapturing()
  }
  const step =
    <A extends ReadonlyArray<unknown>, R>(op: (doc: Y.Doc, by: Writer, ...args: A) => R) =>
    (...args: A): R => {
      nextStep()
      return op(doc, by, ...args)
    }
  return {
    addNote: step(addNote),
    moveNote: step(moveNote),
    stretchNote: step(stretchNote),
    eraseNotes: step(eraseNotes),
    setMute: step(setMute),
    setTrackParam: step(setTrackParam),
    setTrackStrip: step(setTrackStrip),
    setMasterParam: step(setMasterParam),
    setMasterStrip: step(setMasterStrip),
    setTempo: step(setTempo),
    addTrack: step(addTrack),
    renameTrack: step(renameTrack),
    setTrackColour: step(setTrackColour),
    deleteTrack: step(deleteTrack),
    addClip: step(addClip),
    moveClip: step(moveClip),
    resizeClip: step(resizeClip),
    trimClip: step(trimClip),
    eraseClips: step(eraseClips),
    begin: () => {
      nextStep()
      const action = {}
      open.add(action)
      stacksChanged()
      return () => {
        // biome-ignore lint/plugin/control-flow: Yjs's undo manager, plain JS
        if (open.delete(action)) stacksChanged()
      }
    },
    undo: () => open.size === 0 && manager.undo() !== null,
    redo: () => open.size === 0 && manager.redo() !== null,
    canUndo,
    canRedo
  } satisfies Editor
})
