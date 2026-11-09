import { Array, Effect, Equal, Option, Order } from 'effect'
import { Atom, AtomRegistry } from 'effect/reactivity'
import type * as Y from 'yjs'
import { idsOf, notesPattern, projectMaps, type Stored } from './document'
import { Id } from './id'
import type { ArrangementClip, Clip, Master, Note, Track } from './project'
import { ignore, inOrder, readClip, readMaster, readPatternNotes, readTempo, readTrack } from './read'
import { patternEnd } from './time'

/**
 * State whose every write is a batch: what reads it by more than one way, as the compiler's picture reads what this
 * client listens to, holds and plays, sees the new value everywhere at once, never half of the way. Kept alive.
 */
export const batchedState = <A>(initial: A): Atom.Writable<A> => {
  const state = Atom.make(initial).pipe(Atom.keepAlive)
  return Atom.writable(
    (get) => get(state),
    (ctx, value: A) => Atom.batch(() => ctx.set(state, value))
  ).pipe(Atom.keepAlive)
}

/** An atom that tells what depends on it only when its value changes in content, not each time it is read again. */
export const byContent = <A>(read: (get: Atom.AtomContext) => A): Atom.Atom<A> =>
  Atom.readable(read).pipe(Atom.withEquality<A>(Equal.equals))

/** The project read as `readProject` reads it, a part at a time, each part kept up with the document. */
export interface ProjectAtoms {
  readonly tempo: Atom.Atom<number>
  /** The live tracks, in their order. */
  readonly trackIds: Atom.Atom<ReadonlyArray<Id>>
  /** None for a track deleted, or never in the document. */
  readonly track: (id: Id) => Atom.Atom<Option.Option<Track>>
  /** The pattern's notes, by ID: none for one no note was ever put in. */
  readonly notes: (pattern: Id) => Atom.Atom<ReadonlyArray<Note>>
  /** How long the pattern plays, by its notes: `patternEnd`. */
  readonly patternEnd: (pattern: Id) => Atom.Atom<number>
  /** The clips on the live tracks, by ID. */
  readonly clips: Atom.Atom<ReadonlyArray<Clip>>
  /** None for a clip deleted, on a track not live, or never in the document. */
  readonly clip: (id: Id) => Atom.Atom<Option.Option<Clip>>
  /** The same clips as the arrangement plays them, each as long: what draws them and what plays them agree. */
  readonly arrangementClips: Atom.Atom<ReadonlyArray<ArrangementClip>>
  /** One of `arrangementClips`, by ID. */
  readonly arrangementClip: (id: Id) => Atom.Atom<Option.Option<ArrangementClip>>
  readonly master: Atom.Atom<Master>
}

const keysOf = <F>(map: Stored<Record<string, F>>) => byContent(() => Array.sort(idsOf(map), Order.String))

/**
 * The project's atoms, kept up with the document while the scope is open: after each transaction, the parts it touched
 * are read again in one batch, so what depends on several of them runs once.
 */
export const followProject = Effect.fnUntraced(function* (doc: Y.Doc) {
  const registry = yield* AtomRegistry.AtomRegistry
  const maps = projectMaps(doc)
  const tempo = byContent(() => readTempo(ignore, maps.meta))
  const trackKeys = keysOf(maps.tracks)
  const trackEntry = Atom.family((id: Id) => byContent(() => readTrack(ignore, maps.tracks, id)))
  const notesEntry = Atom.family((id: Id) => byContent(() => readPatternNotes(doc, id)))
  const clipKeys = keysOf(maps.clips)
  const clipEntry = Atom.family((id: Id) => byContent(() => readClip(ignore, maps.clips, id)))
  const master = byContent(() => readMaster(ignore, maps.master))
  const trackIds = byContent((get) =>
    inOrder(get(trackKeys).flatMap((id) => Option.toArray(get(trackEntry(id))))).map(({ id }) => id)
  )
  const endOfPattern = Atom.family((id: Id) => byContent((get) => patternEnd(get(notesEntry(id)))))
  /** The clip, if it is on a live track: read again as its own track changes, not as any does. */
  const clip = Atom.family((id: Id) =>
    byContent((get) => Option.filter(get(clipEntry(id)), ({ track }) => Option.isSome(get(trackEntry(track)))))
  )
  const clips = byContent((get) => get(clipKeys).flatMap((id) => Option.toArray(get(clip(id)))))
  const arrangementClip = Atom.family((id: Id) =>
    byContent((get) =>
      Option.map(get(clip(id)), (clip): ArrangementClip => {
        const period = get(endOfPattern(clip.pattern))
        return { ...clip, length: Option.getOrElse(clip.ownLength, () => period), period }
      })
    )
  )
  const atoms: ProjectAtoms = {
    tempo,
    trackIds,
    track: Atom.family((id: Id) => byContent((get) => Option.map(get(trackEntry(id)), ({ value }) => value))),
    notes: notesEntry,
    patternEnd: endOfPattern,
    clips,
    clip,
    arrangementClips: byContent((get) => get(clipKeys).flatMap((id) => Option.toArray(get(arrangementClip(id))))),
    arrangementClip,
    master
  }

  const touched = new Set<Atom.Atom<unknown>>()
  /** A map of entries by ID, each read by the entry atoms given: an entry changed inside, or the keys themselves. */
  const entriesTouched =
    (keys: Atom.Atom<unknown>, ...entries: ReadonlyArray<(id: Id) => Atom.Atom<unknown>>) =>
    (events: ReadonlyArray<Y.YEvent<Y.Map<unknown>>>) => {
      const entryTouched = (id: Id) => entries.forEach((entry) => touched.add(entry(id)))
      events.forEach((event) => {
        const [key] = event.path
        // biome-ignore lint/plugin/control-flow: a Yjs callback, plain JS
        if (key !== undefined) {
          entryTouched(Id(String(key)))
          return
        }
        touched.add(keys)
        event.changes.keys.forEach((_, id) => entryTouched(Id(id)))
      })
    }
  const observers: ReadonlyArray<readonly [Y.Map<unknown>, (events: ReadonlyArray<Y.YEvent<Y.Map<unknown>>>) => void]> =
    [
      [maps.meta, () => touched.add(tempo)],
      [maps.tracks, entriesTouched(trackKeys, trackEntry)],
      [maps.clips, entriesTouched(clipKeys, clipEntry)],
      // Its slots are maps inside it.
      [maps.master, () => touched.add(master)]
    ]
  /** The patterns whose notes, maps of the top, the transaction changed: looked for only if it changed one such. */
  const topTouched = (transaction: Y.Transaction) =>
    Option.map(
      Option.liftPredicate(Array.fromIterable(transaction.changed.keys()), (types) =>
        types.some((type) => type._item === null)
      ),
      () =>
        doc.share.forEach((type, name) =>
          Option.map(
            Option.filter(Option.map(notesPattern(name), notesEntry), () => transaction.changed.has(type)),
            (entry) => touched.add(entry)
          )
        )
    )
  // Deep observers run at the end of the transaction, before this.
  const readTouched = (transaction: Y.Transaction) => {
    topTouched(transaction)
    // biome-ignore lint/plugin/control-flow: a Yjs callback, plain JS
    if (touched.size === 0) return
    const parts = Array.fromIterable(touched)
    touched.clear()
    // One the registry doesn't hold, nothing reads: refreshing would make it and read it for no one.
    const held = registry.getNodes()
    Atom.batch(() => parts.forEach((atom) => held.has(atom) && registry.refresh(atom)))
  }
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      observers.forEach(([map, observer]) => map.observeDeep(observer))
      doc.on('afterTransaction', readTouched)
    }),
    () =>
      Effect.sync(() => {
        doc.off('afterTransaction', readTouched)
        observers.forEach(([map, observer]) => map.unobserveDeep(observer))
      })
  )
  return atoms
})
