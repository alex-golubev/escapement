import { Array, Effect, Equal, Option, Order } from 'effect'
import { Atom, AtomRegistry } from 'effect/reactivity'
import type * as Y from 'yjs'
import { idsOf, insertMap, insertNamed, notesPattern, projectMaps, type Stored } from './document'
import { Id } from './id'
import { insertNumber, master as masterId } from './mixer'
import type { ArrangementClip, Channel, Clip, Insert, Master, Pattern, PatternPlace } from './project'
import {
  ignore,
  inOrder,
  readChannel,
  readClip,
  readInsert,
  readMaster,
  readPatternEntry,
  readPatternNotes,
  readPatternPlace,
  readTempo
} from './read'
import { barTicks, patternEnd } from './steps'

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
  /** The live channels, in their order. */
  readonly channelIds: Atom.Atom<ReadonlyArray<Id>>
  /** None for a channel deleted, or never in the document. */
  readonly channel: (id: Id) => Atom.Atom<Option.Option<Channel>>
  /** Every pattern, a deleted one too, in their order. */
  readonly patternPlaces: Atom.Atom<ReadonlyArray<PatternPlace>>
  /** The live patterns, in their order. */
  readonly patternIds: Atom.Atom<ReadonlyArray<Id>>
  /** None for a pattern deleted, or never in the document. */
  readonly pattern: (id: Id) => Atom.Atom<Option.Option<Pattern>>
  /** Its name alone: its notes aren't read. None for a pattern not there. */
  readonly patternName: (id: Id) => Atom.Atom<Option.Option<string>>
  /** How long the pattern plays, by its notes of the live channels: `patternEnd`, a bar for one not there. */
  readonly patternEnd: (id: Id) => Atom.Atom<number>
  /** The clips of the live patterns, by ID. */
  readonly clips: Atom.Atom<ReadonlyArray<Clip>>
  /** The same clips as the arrangement plays them, each as long: what draws them and what plays them agree. */
  readonly arrangementClips: Atom.Atom<ReadonlyArray<ArrangementClip>>
  readonly master: Atom.Atom<Master>
  /** One of `mixerInserts`, at its defaults while the document holds nothing of it. */
  readonly insert: (id: Id) => Atom.Atom<Insert>
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
  const channelKeys = keysOf(maps.channels)
  const channelEntry = Atom.family((id: Id) => byContent(() => readChannel(ignore, maps.channels, id)))
  const patternKeys = keysOf(maps.patterns)
  const patternEntry = Atom.family((id: Id) => byContent(() => readPatternEntry(ignore, maps.patterns, id)))
  const placeEntry = Atom.family((id: Id) => byContent(() => readPatternPlace(maps.patterns, id)))
  const notesEntry = Atom.family((id: Id) => byContent(() => readPatternNotes(doc, id)))
  const clipKeys = keysOf(maps.clips)
  const clipEntry = Atom.family((id: Id) => byContent(() => readClip(ignore, maps.clips, id)))
  const masterMap = insertMap(doc, masterId)
  const master = byContent(() => readMaster(ignore, doc))
  const insert = Atom.family((id: Id) => byContent(() => readInsert(ignore, doc, id)))
  const channelIds = byContent((get) =>
    inOrder(get(channelKeys).flatMap((id) => Option.toArray(get(channelEntry(id))))).map(({ id }) => id)
  )
  const patternPlaces = byContent((get) =>
    inOrder(get(patternKeys).flatMap((id) => Option.toArray(get(placeEntry(id)))))
  )
  const patternIds = byContent((get) =>
    get(patternPlaces)
      .filter(({ live }) => live)
      .map(({ id }) => id)
  )
  const pattern = Atom.family((id: Id) =>
    byContent((get) => Option.map(get(patternEntry(id)), ({ value }) => ({ ...value, notes: get(notesEntry(id)) })))
  )
  const endOfPattern = Atom.family((id: Id) =>
    byContent((get) => {
      const live = new Set(get(channelIds))
      return Option.match(get(pattern(id)), {
        onNone: () => barTicks,
        onSome: ({ notes }) => patternEnd(notes.filter(({ channel }) => live.has(channel)))
      })
    })
  )
  const clips = byContent((get) => {
    const live = new Set(get(patternIds))
    return get(clipKeys).flatMap((id) =>
      Option.toArray(Option.filter(get(clipEntry(id)), ({ pattern }) => live.has(pattern)))
    )
  })
  const atoms: ProjectAtoms = {
    tempo,
    channelIds,
    channel: Atom.family((id: Id) => byContent((get) => Option.map(get(channelEntry(id)), ({ value }) => value))),
    patternPlaces,
    patternIds,
    pattern,
    patternName: Atom.family((id: Id) =>
      byContent((get) => Option.map(get(patternEntry(id)), ({ value }) => value.name))
    ),
    patternEnd: endOfPattern,
    clips,
    arrangementClips: byContent((get) =>
      get(clips).map((clip) => {
        const period = get(endOfPattern(clip.pattern))
        return { ...clip, length: Option.getOrElse(clip.ownLength, () => period), period }
      })
    ),
    master,
    insert
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
      [maps.channels, entriesTouched(channelKeys, channelEntry)],
      [maps.patterns, entriesTouched(patternKeys, patternEntry, placeEntry)],
      [maps.clips, entriesTouched(clipKeys, clipEntry)],
      // Its slots are maps inside it.
      [masterMap, () => touched.add(master)]
    ]
  /** What a map of the document's top holds by its name: a pattern's notes, or an insert's own but the master's. */
  const topEntry = (name: string): Option.Option<Atom.Atom<unknown>> =>
    Option.orElse(Option.map(notesPattern(name), notesEntry), () =>
      Option.map(
        Option.filter(insertNamed(name), (id) => Option.exists(insertNumber(id), (number) => number > 0)),
        insert
      )
    )
  /**
   * The parts held in maps of the document's top the transaction changed, found by their names, looked for only when
   * it changed a map of the top itself, as an edit of notes or of an insert does and an edit inside a channel doesn't.
   */
  const topTouched = (transaction: Y.Transaction) =>
    Option.map(
      Option.liftPredicate(Array.fromIterable(transaction.changed.keys()), (types) =>
        types.some((type) => type._item === null)
      ),
      () =>
        doc.share.forEach((type, name) =>
          Option.map(
            Option.filter(topEntry(name), () => transaction.changed.has(type)),
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
