import type { ParamId, Plugin, StripParamId } from '@escapement/engine-description'
import { Effect, Option } from 'effect'
import { Atom, AtomRegistry } from 'effect/reactivity'
import * as Y from 'yjs'
import type { Id } from './id'
import {
  addChannel,
  addClip,
  addNote,
  addPattern,
  type ClipPlace,
  type ClipSpan,
  clonePattern,
  deleteChannel,
  deletePattern,
  eraseClips,
  eraseNotes,
  moveClip,
  resizeClip,
  trimClip,
  moveNote,
  type NewNote,
  renameChannel,
  renamePattern,
  setChannelInsert,
  setChannelParam,
  setChannelStrip,
  setInsertMute,
  setInsertStrip,
  setMasterParam,
  setMute,
  setTempo,
  stretchNote,
  toggleStep
} from './operations'
import type { Writer } from './writer'

/**
 * A writer's edits of one document, each a step of its history, which takes back the writer's own changes and no one
 * else's. Each edit returns false if what it acts on isn't there.
 */
export interface Editor {
  readonly toggleStep: (pattern: Id, channel: Id, step: number) => boolean
  readonly addNote: (pattern: Id, channel: Id, note: NewNote) => boolean
  readonly moveNote: (pattern: Id, note: Id, to: Pick<NewNote, 'tick' | 'key'>) => boolean
  readonly stretchNote: (pattern: Id, note: Id, length: number) => boolean
  readonly eraseNotes: (pattern: Id, notes: ReadonlyArray<Id>) => boolean
  readonly setMute: (channel: Id, mute: boolean) => boolean
  readonly setChannelParam: (channel: Id, param: ParamId<Plugin>, value: number) => boolean
  readonly setChannelStrip: (channel: Id, param: StripParamId, value: number) => boolean
  readonly setMasterParam: (slot: Id, param: ParamId<Plugin>, value: number) => boolean
  readonly setChannelInsert: (channel: Id, insert: Id) => boolean
  readonly setInsertStrip: (insert: Id, param: StripParamId, value: number) => boolean
  readonly setInsertMute: (insert: Id, mute: boolean) => boolean
  readonly setTempo: (bpm: number) => boolean
  readonly addChannel: () => boolean
  readonly renameChannel: (channel: Id, name: string) => boolean
  readonly deleteChannel: (channel: Id) => boolean
  /**
   * The new pattern's ID; none if the document holds no project, or while an action is open: it would be a step of the
   * gesture, and the page would show it in the gesture's middle.
   */
  readonly addPattern: () => Option.Option<Id>
  /** The copy's ID; none if the pattern isn't live, or while an action is open, as for `addPattern`. */
  readonly clonePattern: (pattern: Id) => Option.Option<Id>
  readonly renamePattern: (pattern: Id, name: string) => boolean
  readonly deletePattern: (pattern: Id) => boolean
  /** The new clip's ID; none if the pattern isn't live, or the place is on no track. */
  readonly addClip: (pattern: Id, place: ClipPlace) => Option.Option<Id>
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
  /** A step that brings in a pattern: none while an action is open. */
  const alone =
    <A extends ReadonlyArray<unknown>>(op: (doc: Y.Doc, by: Writer, ...args: A) => Option.Option<Id>) =>
    (...args: A): Option.Option<Id> =>
      Option.flatMap(
        Option.liftPredicate(open, (open) => open.size === 0),
        () => step(op)(...args)
      )
  return {
    toggleStep: step(toggleStep),
    addNote: step(addNote),
    moveNote: step(moveNote),
    stretchNote: step(stretchNote),
    eraseNotes: step(eraseNotes),
    setMute: step(setMute),
    setChannelParam: step(setChannelParam),
    setChannelStrip: step(setChannelStrip),
    setMasterParam: step(setMasterParam),
    setChannelInsert: step(setChannelInsert),
    setInsertStrip: step(setInsertStrip),
    setInsertMute: step(setInsertMute),
    setTempo: step(setTempo),
    addChannel: step(addChannel),
    renameChannel: step(renameChannel),
    deleteChannel: step(deleteChannel),
    addPattern: alone(addPattern),
    clonePattern: alone(clonePattern),
    renamePattern: step(renamePattern),
    deletePattern: step(deletePattern),
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
