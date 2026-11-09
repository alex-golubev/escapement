import {
  defaultTempo,
  lastTick,
  type MidiKey,
  maxTempo,
  minTempo,
  nearestIn,
  type ParamDescription,
  type ParamId,
  type Plugin,
  plugins,
  type SampleSounds,
  type Sha256,
  type StripParamId,
  strip,
  Tick
} from '@escapement/engine-description'
import { Array, Boolean, Equal, Number, Option, Order, Predicate, Record, Schema, String } from 'effect'
import { generateKeyBetween } from 'fractional-indexing'
import type * as Y from 'yjs'
import {
  type ClipBounds,
  type ClipFields,
  get,
  idsOf,
  type Key,
  mapAt,
  type NoteFields,
  newMap,
  type PluginFields,
  type ProjectMaps,
  patternNotes,
  projectMaps,
  remove,
  type Stored,
  set,
  type TrackFields
} from './document'
import { type Id, newId } from './id'
import type { Clip, Note } from './project'
import { samePlace, withMoved, withPut, withStretched } from './notes'
import { finite, ignore, isDeleted, latestEnd, readClip, readNotes, readPluginName, readTrack } from './read'
import { defaultNote } from './time'
import { trackStrip } from './track-strip'
import { newWriter, type Writer } from './writer'

// An operation writes only values reading takes as they are, in a transaction marked as its writer's. It returns false,
// changing nothing, when what it acts on isn't in the document or a value isn't a number. A map reading takes as empty,
// missing or broken, it first makes anew, in a transaction of its own that no history takes back: an undo of the edit
// leaves the map, and what others wrote into it since. Two clients making the same map at once keep one of them, and
// what the other wrote into its own is lost.

/** A step is a whole number. */
const isWhole = Schema.is(Schema.Int)

/**
 * Writes what an edit needs in place before it, as a map mended: no history tracks it, since each takes back only its
 * own writer's changes.
 */
const setup = newWriter('setup')

/** What an operation writes; nothing when the document already holds it. */
type Change = Option.Option<() => void>

const transact = (doc: Y.Doc, by: Writer, change: Option.Option<Change>): boolean =>
  Option.match(change, {
    onNone: () => false,
    // Nothing to write is done too.
    onSome: (written) =>
      Option.match(written, {
        onNone: () => true,
        onSome: (act) => {
          doc.transact(act, by)
          return true
        }
      })
  })

/** Nothing when the document reads as the value already: it holds it, or holds nothing there and reads `absent`. */
const write = <F, K extends Key<F>>(map: Stored<F>, key: K, value: F[K], absent: F[K]): Change =>
  Option.map(
    Option.liftPredicate(
      value,
      (value) => Option.getOrElse(Option.fromUndefinedOr(get(map, key)), () => absent) !== value
    ),
    (value) => () => set(map, key, value)
  )

/** Each change there is, as one. */
const together = (changes: ReadonlyArray<Change>): Change =>
  Array.match(Array.getSomes(changes), {
    onEmpty: () => Option.none(),
    onNonEmpty: (acts) => Option.some(() => acts.forEach((act) => act()))
  })

/** Never inside another transaction, which would take the setup as its own, and an undo of it with it. */
const setUp = (doc: Y.Doc, act: () => void) =>
  Boolean.match(doc._transaction !== null, {
    onTrue: () => {
      throw new Error('Setup is written in a transaction of its own')
    },
    onFalse: () => doc.transact(act, setup)
  })

/** The map the layout puts under `key`, set up anew and empty first if reading takes it as empty. */
const mended = <F, K extends Key<F>>(doc: Y.Doc, parent: Stored<F>, key: K, empty: () => F[K] & Y.Map<unknown>) =>
  Option.getOrElse(mapAt(parent, key), () => {
    const made = empty()
    setUp(doc, () => set(parent, key, made))
    return made
  })

/** Anything in the document is its project: only `createProject` writes into an empty one. */
const holdsProject = (maps: ProjectMaps) => Object.values(maps).some((map) => map.size > 0)

const live = <F extends { readonly deleted: boolean }>(map: Option.Option<Stored<F>>) =>
  Option.filter(map, (entry) => !isDeleted(entry))

const liveTrack = ({ tracks }: ProjectMaps, id: Id) => live(mapAt(tracks, id))

/** A live clip on a live track: its map, and the clip as it reads. */
const liveClip = (maps: ProjectMaps, id: Id) =>
  Option.gen(function* () {
    const map = yield* live(mapAt(maps.clips, id))
    const read = yield* readClip(ignore, maps.clips, id)
    yield* liveTrack(maps, read.track)
    return { map, read }
  })

/** Where a clip can start: a whole tick of the engine's. */
const inTime = (tick: number) => isWhole(tick) && tick >= 0 && tick <= lastTick

/** A name as typed, without the spaces around it; none if nothing else is left. */
const typedName = (name: string) => Option.liftPredicate(String.trim(name), String.isNonEmpty)

const masterSlot = (doc: Y.Doc, id: Id) =>
  live(Option.flatMap(mapAt(projectMaps(doc).master, 'slots'), (slots) => mapAt(slots, id)))

/** Where a note starts, how high it is and how long, in whole ticks from 1. */
export interface NewNote {
  readonly tick: Tick
  readonly key: MidiKey
  readonly length: number
}

const fits = ({ tick, length }: Pick<Note, 'tick' | 'length'>) =>
  isWhole(length) && length >= 1 && tick + length <= latestEnd

/**
 * Writes the pattern's notes as `after` has them, if each it changes ends by `latestEnd`: takes out those it lacks, and
 * sets those it changes or adds.
 */
const rewritten = (
  notes: Stored<Record<string, NoteFields>>,
  before: ReadonlyArray<Note>,
  after: ReadonlyArray<Note>
): Option.Option<Change> => {
  const gone = before.filter((note) => !after.some(({ id }) => id === note.id))
  const written = after.filter((note) => !before.some((was) => Equal.equals(was, note)))
  return Option.map(
    Option.liftPredicate(written, (written) => written.every(fits)),
    (written) =>
      Option.map(Array.match([...gone, ...written], { onEmpty: Option.none, onNonEmpty: Option.some }), () => () => {
        gone.forEach(({ id }) => remove(notes, id))
        written.forEach(({ id, tick, length, key, velocity }) =>
          set(notes, id, { tick, len: length, key, vel: velocity })
        )
      })
  )
}

/** The notes of the pattern of a live clip on a live track, as the document holds them and as they read. */
const notesOfClip = (doc: Y.Doc, clip: Id) =>
  Option.map(liveClip(projectMaps(doc), clip), ({ read }) => {
    const notes = patternNotes(doc, read.pattern)
    return { notes, read: readNotes(notes) }
  })

/** A note of a live clip's pattern, with the pattern's notes. */
const noteIn = (doc: Y.Doc, clip: Id, id: Id) =>
  Option.flatMap(notesOfClip(doc, clip), ({ notes, read }) =>
    Option.map(
      Array.findFirst(read, (note) => note.id === id),
      (note) => ({ notes, read, note })
    )
  )

/**
 * Puts a note into the clip's pattern, at full strength, if it ends by `latestEnd`, in place of the notes in its place.
 * Refused for a clip not live, or on a track not live.
 */
export const addNote = (doc: Y.Doc, by: Writer, clip: Id, place: NewNote): boolean =>
  transact(
    doc,
    by,
    Option.gen(function* () {
      yield* Option.liftPredicate(place, fits)
      const { notes, read } = yield* notesOfClip(doc, clip)
      return yield* rewritten(notes, read, withPut(read, { id: newId(), ...place, velocity: defaultNote.velocity }))
    })
  )

/**
 * Moves the note of the clip's pattern, with the notes in its place, to start and be as high as asked, each as long as it
 * was, in place of the notes there. One no longer there, or of a clip refused as `addNote` refuses it, is refused.
 */
export const moveNote = (doc: Y.Doc, by: Writer, clip: Id, id: Id, to: Pick<NewNote, 'tick' | 'key'>): boolean =>
  transact(
    doc,
    by,
    Option.flatMap(noteIn(doc, clip, id), ({ notes, read, note }) => rewritten(notes, read, withMoved(read, note, to)))
  )

/** Makes the note, with the notes in its place, as long as asked; refused as a moved one is. */
export const stretchNote = (doc: Y.Doc, by: Writer, clip: Id, id: Id, length: number): boolean =>
  transact(
    doc,
    by,
    Option.flatMap(noteIn(doc, clip, id), ({ notes, read, note }) =>
      rewritten(notes, read, withStretched(read, note, length))
    )
  )

/**
 * Takes the notes out of the clip's pattern, each with the notes in its place, as two clients that put the same note at
 * once made two. One no longer there is passed over; a clip refused as `addNote` refuses it, refused.
 */
export const eraseNotes = (doc: Y.Doc, by: Writer, clip: Id, ids: ReadonlyArray<Id>): boolean =>
  transact(
    doc,
    by,
    Option.map(notesOfClip(doc, clip), ({ notes, read }) => {
      const erased = read.filter((note) => ids.includes(note.id))
      const alike = read.filter((note) => erased.some((one) => samePlace(one, note)))
      return Option.map(
        Array.match(alike, { onEmpty: Option.none, onNonEmpty: Option.some }),
        (gone) => () => gone.forEach(({ id }) => remove(notes, id))
      )
    })
  )

/** Into the plugin's range, a choice the nearest. */
const setParam = (doc: Y.Doc, instance: Option.Option<Stored<PluginFields>>, param: ParamId<Plugin>, value: number) =>
  Option.gen(function* () {
    const map = yield* instance
    const params: ReadonlyArray<ParamDescription> = plugins[yield* readPluginName(map)].params
    const description = yield* Option.fromUndefinedOr(params.find(({ id }) => id === param))
    const valid = nearestIn(description, yield* finite(value))
    return write(
      mended(doc, map, 'params', () => newMap<Record<string, number>>({})),
      param,
      valid,
      description.default
    )
  })

/** A parameter of the track's instrument, such as a synth's oscillator's shape. */
export const setTrackParam = (doc: Y.Doc, by: Writer, track: Id, param: ParamId<Plugin>, value: number): boolean =>
  transact(
    doc,
    by,
    setParam(
      doc,
      Option.flatMap(liveTrack(projectMaps(doc), track), (map) => mapAt(map, 'instrument')),
      param,
      value
    )
  )

/** A parameter of a plugin on the master, such as the filter's cutoff. */
export const setMasterParam = (doc: Y.Doc, by: Writer, slot: Id, param: ParamId<Plugin>, value: number): boolean =>
  transact(doc, by, setParam(doc, masterSlot(doc, slot), param, value))

/** A parameter of the track's strip, such as its pan, into the strip's range. */
export const setTrackStrip = (doc: Y.Doc, by: Writer, track: Id, param: StripParamId, value: number): boolean =>
  transact(
    doc,
    by,
    Option.gen(function* () {
      const map = yield* liveTrack(projectMaps(doc), track)
      const description = yield* Option.fromUndefinedOr(trackStrip.find(({ id }) => id === param))
      const valid = nearestIn(description, yield* finite(value))
      return write(map, param, valid, description.default)
    })
  )

export const setMute = (doc: Y.Doc, by: Writer, track: Id, mute: boolean): boolean =>
  transact(
    doc,
    by,
    Option.map(liveTrack(projectMaps(doc), track), (map) => write(map, 'mute', mute, false))
  )

/** A parameter of the master's strip, such as its volume, into the strip's range; refused while there is no project. */
export const setMasterStrip = (doc: Y.Doc, by: Writer, param: StripParamId, value: number): boolean =>
  transact(
    doc,
    by,
    Option.gen(function* () {
      const maps = projectMaps(doc)
      yield* Option.liftPredicate(maps, holdsProject)
      const description = yield* Option.fromUndefinedOr(strip.find(({ id }) => id === param))
      const valid = nearestIn(description, yield* finite(value))
      return write(maps.master, param, valid, description.default)
    })
  )

/** Without the spaces around it; refused if nothing else is left. Another track may have it too. */
export const renameTrack = (doc: Y.Doc, by: Writer, track: Id, name: string): boolean =>
  transact(
    doc,
    by,
    Option.gen(function* () {
      const map = yield* liveTrack(projectMaps(doc), track)
      return write(map, 'name', yield* typedName(name), '')
    })
  )

/**
 * Marked so, all it holds left in the document, and its clips hidden with it: an undo brings it back whole, its clips
 * with it, and an edit made in it offline stays.
 */
export const deleteTrack = (doc: Y.Doc, by: Writer, track: Id): boolean =>
  transact(
    doc,
    by,
    Option.map(liveTrack(projectMaps(doc), track), (map) => write(map, 'deleted', true, false))
  )

/** Into the engine's range. */
export const setTempo = (doc: Y.Doc, by: Writer, bpm: number): boolean => {
  const maps = projectMaps(doc)
  return transact(
    doc,
    by,
    Option.gen(function* () {
      yield* Option.liftPredicate(maps, holdsProject)
      const valid = yield* finite(bpm)
      return write(maps.meta, 'bpm', Number.clamp(valid, { minimum: minTempo, maximum: maxTempo }), defaultTempo)
    })
  )
}

const newInstance = <P extends Plugin>(plugin: P, sounds: SampleSounds<P> = {}): PluginFields => {
  const bySample: { readonly [sample: string]: Sha256 | undefined } = sounds
  return {
    plugin: { id: plugin.id, version: plugin.version },
    params: newMap<Record<string, number>>({}),
    samples: newMap<Record<string, Sha256>>(Record.filter(bySample, Predicate.isNotUndefined))
  }
}

/** The label, or else the label with the first number from 2 that names no track: one of these is always free. */
const freeName = (label: string, taken: ReadonlyArray<string>): string => {
  const names = new Set(taken)
  const candidates = [label, ...Array.makeBy(taken.length, (i) => `${label} ${i + 2}`)]
  return Option.getOrElse(
    Array.findFirst(candidates, (name) => !names.has(name)),
    () => label
  )
}

/** A fractional index after the greatest of `orders` that is one; the first index if none is. */
const orderAfter = (orders: ReadonlyArray<string>): string =>
  Option.getOrElse(
    Array.findFirst(Array.sort(orders, Order.flip(Order.String)), (order) =>
      Option.liftThrowable(() => generateKeyBetween(order, null))()
    ),
    () => generateKeyBetween(null, null)
  )

/** The place of every entry, a deleted one's too: an undo brings it back there. */
const placesTaken = (entries: Stored<Record<string, Stored<{ readonly order: string }>>>): ReadonlyArray<string> =>
  idsOf(entries).flatMap((id) =>
    Option.toArray(
      Option.flatMap(mapAt(entries, id), (map) => Option.liftPredicate(get(map, 'order'), Predicate.isString))
    )
  )

/**
 * An entry made deleted, set up with what `fill` writes for it, then brought in by the writer: an undo puts it back in
 * the trash, and what another client wrote into it since with it. Its ID.
 */
const broughtIn = <F extends { readonly deleted: boolean }>(
  doc: Y.Doc,
  by: Writer,
  entries: Stored<Record<string, Stored<F>>>,
  made: Stored<F>,
  fill: (id: Id) => void = () => {}
): Id => {
  const id = newId()
  const deletable: Stored<{ readonly deleted: boolean }> = made
  setUp(doc, () => {
    set(entries, id, made)
    fill(id)
  })
  doc.transact(() => set(deletable, 'deleted', false), by)
  return id
}

/** Where a clip goes: a track, by ID, and the tick it starts at. */
export interface ClipPlace {
  readonly track: Id
  readonly tick: Tick
}

/**
 * A new clip at the place, with a pattern of its own, as long as its pattern: a bar while it has no notes. Brought in so
 * that an undo puts it in the trash. Its ID; none if the track isn't live, or the tick isn't a whole one of the engine's.
 */
export const addClip = (doc: Y.Doc, by: Writer, { track, tick }: ClipPlace): Option.Option<Id> => {
  const maps = projectMaps(doc)
  return Option.map(Option.all([liveTrack(maps, track), Option.liftPredicate(tick, inTime)]), () =>
    broughtIn(
      doc,
      by,
      maps.clips,
      newMap<ClipFields>({
        track,
        bounds: boundsOf({ tick, ownLength: Option.none(), offset: 0 }),
        pattern: newId(),
        deleted: true
      })
    )
  )
}

/**
 * What the document holds of the clip's place in time, one value, as it reads: its length only if its own, its offset
 * only if it starts inside a round.
 */
const boundsOf = ({ tick, ownLength, offset }: Pick<Clip, 'tick' | 'ownLength' | 'offset'>): ClipBounds => ({
  tick,
  ...Option.match(ownLength, { onNone: () => ({}), onSome: (length) => ({ length }) }),
  ...Boolean.match(offset === 0, { onTrue: () => ({}), onFalse: () => ({ offset }) })
})

/**
 * Moves the clip to the place, writing its track and its bounds each only if the document holds otherwise: on another
 * track it plays that track's instrument. One not live, or on a track not live, which no one sees, is refused, and so
 * is a place on a track not live, or not in time, or one a length of its own ends too late at.
 */
export const moveClip = (doc: Y.Doc, by: Writer, clip: Id, to: ClipPlace): boolean => {
  const maps = projectMaps(doc)
  return transact(
    doc,
    by,
    Option.gen(function* () {
      yield* liveTrack(maps, to.track)
      yield* Option.liftPredicate(to.tick, inTime)
      const { map, read } = yield* liveClip(maps, clip)
      yield* Option.liftPredicate(to, ({ tick }) =>
        Option.match(read.ownLength, { onNone: () => true, onSome: (length) => fits({ tick, length }) })
      )
      return together([
        Option.map(
          Option.liftPredicate(to.track, (track) => get(map, 'track') !== track),
          (track) => () => set(map, 'track', track)
        ),
        Option.map(
          Option.liftPredicate(
            boundsOf({ ...read, tick: to.tick }),
            (bounds) => !Equal.equals(get(map, 'bounds'), bounds)
          ),
          (bounds) => () => set(map, 'bounds', bounds)
        )
      ])
    })
  )
}

/**
 * Makes the clip so long, a length of its own from then on, writing its bounds only if the document holds otherwise. A
 * length not whole, under a tick or ending past `latestEnd` is refused, as is a clip not live, or on a track not live.
 */
export const resizeClip = (doc: Y.Doc, by: Writer, clip: Id, length: number): boolean => {
  const maps = projectMaps(doc)
  return transact(
    doc,
    by,
    Option.gen(function* () {
      const { map, read } = yield* liveClip(maps, clip)
      const ownLength = yield* Option.liftPredicate(length, (length) => fits({ tick: read.tick, length }))
      return Option.map(
        Option.liftPredicate(
          boundsOf({ ...read, ownLength: Option.some(ownLength) }),
          (bounds) => !Equal.equals(get(map, 'bounds'), bounds)
        ),
        (bounds) => () => set(map, 'bounds', bounds)
      )
    })
  )
}

/** Where a clip starts, how long it plays and where in its pattern's rounds, as its left edge moves them together. */
export interface ClipSpan {
  readonly tick: Tick
  /** Ticks, from 1: a length of its own. */
  readonly length: number
  /** Ticks into its pattern's rounds, as `Clip` has it. */
  readonly offset: number
}

/**
 * Starts the clip so, as long and from so far into a round of its pattern, writing its bounds only if the document holds
 * otherwise. A tick or an offset not whole or out of range, a length that doesn't fit, a clip not live, or on a track
 * not live, is refused.
 */
export const trimClip = (doc: Y.Doc, by: Writer, clip: Id, span: ClipSpan): boolean => {
  const maps = projectMaps(doc)
  return transact(
    doc,
    by,
    Option.gen(function* () {
      const { map } = yield* liveClip(maps, clip)
      const { tick, length, offset } = yield* Option.liftPredicate(
        span,
        ({ tick, length, offset }) =>
          fits({ tick, length }) && isWhole(tick) && tick >= 0 && isWhole(offset) && Math.abs(offset) <= lastTick
      )
      return Option.map(
        Option.liftPredicate(
          boundsOf({ tick, ownLength: Option.some(length), offset }),
          (bounds) => !Equal.equals(get(map, 'bounds'), bounds)
        ),
        (bounds) => () => set(map, 'bounds', bounds)
      )
    })
  )
}

/** Marked so, as a deleted track is: an undo brings each back. One not live, or on a track not live, is passed over. */
export const eraseClips = (doc: Y.Doc, by: Writer, ids: ReadonlyArray<Id>): boolean => {
  const maps = projectMaps(doc)
  return transact(
    doc,
    by,
    Option.map(Option.liftPredicate(maps, holdsProject), () =>
      together(ids.map((id) => Option.flatMap(liveClip(maps, id), ({ map }) => write(map, 'deleted', true, false))))
    )
  )
}

/** What a new track plays: a plugin of the catalog, and the sounds of its samples. */
export interface NewInstrument {
  readonly plugin: Plugin
  readonly sounds: SampleSounds<Plugin>
}

/** What "+" puts on a new track. */
export const synth: NewInstrument = { plugin: plugins.synth, sounds: {} }

/**
 * A track after every other, a deleted one too, playing the instrument at its defaults, named after it so that no live
 * track has its name: "Synth", then "Synth 2" and on. Brought in so that an undo puts it in the trash, with the clips put
 * on it since. Its ID; none if the document holds no project.
 */
export const addTrack = (doc: Y.Doc, by: Writer, instrument: NewInstrument = synth): Option.Option<Id> => {
  const maps = projectMaps(doc)
  return Option.map(Option.liftPredicate(maps, holdsProject), () => {
    const live = idsOf(maps.tracks).flatMap((id) => Option.toArray(readTrack(ignore, maps.tracks, id)))
    const name = freeName(
      instrument.plugin.label,
      live.map(({ value }) => value.name)
    )
    return broughtIn(
      doc,
      by,
      maps.tracks,
      newMap<TrackFields>({
        name,
        order: orderAfter(placesTaken(maps.tracks)),
        deleted: true,
        mute: false,
        instrument: newMap(newInstance(instrument.plugin, instrument.sounds))
      })
    )
  })
}

/**
 * A new project, with the ID given or one of its own: only the master, with nothing on it, and the tempo at the
 * engine's. False if the document already holds one.
 */
export const createProject = (doc: Y.Doc, by: Writer, id: Id = newId()): boolean => {
  const maps = projectMaps(doc)
  const create = () => {
    set(maps.meta, 'id', id)
    set(maps.meta, 'bpm', defaultTempo)
  }
  return transact(
    doc,
    by,
    Boolean.match(holdsProject(maps), { onTrue: () => Option.none(), onFalse: () => Option.some(Option.some(create)) })
  )
}
