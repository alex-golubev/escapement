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
import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing'
import type * as Y from 'yjs'
import {
  type ChannelFields,
  type ClipBounds,
  type ClipFields,
  get,
  idsOf,
  insertMap,
  type Key,
  mapAt,
  type NoteFields,
  newMap,
  type PatternFields,
  type PluginFields,
  type ProjectMaps,
  patternNotes,
  projectMaps,
  remove,
  type SlotFields,
  type Stored,
  set
} from './document'
import { channelStrip } from './channel-strip'
import { type Id, newId } from './id'
import { trackPlace } from './arrangement'
import { insertNumber, master } from './mixer'
import type { Clip, Note } from './project'
import { samePlace, withMoved, withPut, withStretched } from './notes'
import {
  finite,
  ignore,
  isDeleted,
  latestEnd,
  readChannel,
  readClip,
  readNote,
  readNotes,
  readPatternEntry,
  readPluginName
} from './read'
import { stepNote, stepTicks } from './steps'
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

const liveChannel = ({ channels }: ProjectMaps, id: Id) => live(mapAt(channels, id))

const livePattern = ({ patterns }: ProjectMaps, id: Id) => live(mapAt(patterns, id))

/** A name as typed, without the spaces around it; none if nothing else is left. */
const typedName = (name: string) => Option.liftPredicate(String.trim(name), String.isNonEmpty)

const masterSlot = (doc: Y.Doc, id: Id) =>
  live(Option.flatMap(mapAt(insertMap(doc, master), 'slots'), (slots) => mapAt(slots, id)))

/** The insert's own, if the document holds a project and the ID names an insert there is. */
const insertOf = (doc: Y.Doc, insert: Id, pass: (number: number) => boolean = () => true) =>
  Option.map(
    Option.filter(Option.filter(insertNumber(insert), pass), () => holdsProject(projectMaps(doc))),
    () => insertMap(doc, insert)
  )

/**
 * Switches the step on if the channel has no note on its tick, with `stepNote`; otherwise off, removing every note of
 * the channel on the tick, whatever its key: two clients that switched the same step on made two notes.
 */
export const toggleStep = (doc: Y.Doc, by: Writer, pattern: Id, channel: Id, step: number): boolean => {
  const maps = projectMaps(doc)
  const tick = step * stepTicks
  return transact(
    doc,
    by,
    Option.gen(function* () {
      yield* Option.liftPredicate(step, isWhole)
      yield* Option.liftPredicate(tick, (start) => start >= 0 && start + stepNote.length <= latestEnd)
      yield* liveChannel(maps, channel)
      yield* livePattern(maps, pattern)
      const note: NoteFields = {
        channel,
        tick: Tick(tick),
        len: stepNote.length,
        key: stepNote.key,
        vel: stepNote.velocity
      }
      const notes = patternNotes(doc, pattern)
      const on = idsOf(notes).filter((id) =>
        Option.exists(readNote(id, get(notes, id)), (read) => read.channel === channel && read.tick === tick)
      )
      return Option.some(
        Array.match(on, {
          onEmpty: () => () => set(notes, newId(), note),
          onNonEmpty: (on) => () => on.forEach((id) => remove(notes, id))
        })
      )
    })
  )
}

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
        written.forEach(({ id, channel, tick, length, key, velocity }) =>
          set(notes, id, { channel, tick, len: length, key, vel: velocity })
        )
      })
  )
}

/** A note of a live channel in a live pattern, with the pattern's notes. */
const noteIn = (doc: Y.Doc, pattern: Id, id: Id) =>
  Option.gen(function* () {
    const maps = projectMaps(doc)
    yield* livePattern(maps, pattern)
    const notes = patternNotes(doc, pattern)
    const read = readNotes(notes)
    const note = yield* Array.findFirst(read, (note) => note.id === id)
    yield* liveChannel(maps, note.channel)
    return { notes, read, note }
  })

/**
 * Puts a note of the channel into the pattern, at full strength as a step's, if it ends by `latestEnd`, in place of the
 * notes in its place.
 */
export const addNote = (doc: Y.Doc, by: Writer, pattern: Id, channel: Id, place: NewNote): boolean => {
  const maps = projectMaps(doc)
  return transact(
    doc,
    by,
    Option.gen(function* () {
      yield* Option.liftPredicate(place, fits)
      yield* liveChannel(maps, channel)
      yield* livePattern(maps, pattern)
      const notes = patternNotes(doc, pattern)
      const read = readNotes(notes)
      return yield* rewritten(
        notes,
        read,
        withPut(read, { id: newId(), channel, ...place, velocity: stepNote.velocity })
      )
    })
  )
}

/**
 * Moves the note, with the notes in its place, to start and be as high as asked, each as long as it was, in place of the
 * notes there. One no longer there, or of a channel not there, is refused.
 */
export const moveNote = (doc: Y.Doc, by: Writer, pattern: Id, id: Id, to: Pick<NewNote, 'tick' | 'key'>): boolean =>
  transact(
    doc,
    by,
    Option.flatMap(noteIn(doc, pattern, id), ({ notes, read, note }) =>
      rewritten(notes, read, withMoved(read, note, to))
    )
  )

/** Makes the note, with the notes in its place, as long as asked; refused as a moved one is. */
export const stretchNote = (doc: Y.Doc, by: Writer, pattern: Id, id: Id, length: number): boolean =>
  transact(
    doc,
    by,
    Option.flatMap(noteIn(doc, pattern, id), ({ notes, read, note }) =>
      rewritten(notes, read, withStretched(read, note, length))
    )
  )

/**
 * Takes the notes out of the pattern, each with the notes in its place, as two clients that put the same note at once
 * made two. One no longer there is passed over.
 */
export const eraseNotes = (doc: Y.Doc, by: Writer, pattern: Id, ids: ReadonlyArray<Id>): boolean =>
  transact(
    doc,
    by,
    Option.map(livePattern(projectMaps(doc), pattern), () => {
      const notes = patternNotes(doc, pattern)
      const read = readNotes(notes)
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

/** A parameter of the channel's instrument, such as its volume. */
export const setChannelParam = (doc: Y.Doc, by: Writer, channel: Id, param: ParamId<Plugin>, value: number): boolean =>
  transact(
    doc,
    by,
    setParam(
      doc,
      Option.flatMap(liveChannel(projectMaps(doc), channel), (map) => mapAt(map, 'instrument')),
      param,
      value
    )
  )

/** A parameter of a plugin on the master insert, such as the filter's cutoff. */
export const setMasterParam = (doc: Y.Doc, by: Writer, slot: Id, param: ParamId<Plugin>, value: number): boolean =>
  transact(doc, by, setParam(doc, masterSlot(doc, slot), param, value))

/** A parameter of the channel's strip, such as its pan, into the strip's range. */
export const setChannelStrip = (doc: Y.Doc, by: Writer, channel: Id, param: StripParamId, value: number): boolean =>
  transact(
    doc,
    by,
    Option.gen(function* () {
      const map = yield* liveChannel(projectMaps(doc), channel)
      const description = yield* Option.fromUndefinedOr(channelStrip.find(({ id }) => id === param))
      const valid = nearestIn(description, yield* finite(value))
      return write(map, param, valid, description.default)
    })
  )

export const setMute = (doc: Y.Doc, by: Writer, channel: Id, mute: boolean): boolean =>
  transact(
    doc,
    by,
    Option.map(liveChannel(projectMaps(doc), channel), (map) => write(map, 'mute', mute, false))
  )

/** The mixer's insert the channel goes into: the master, or one of `mixerInserts`. */
export const setChannelInsert = (doc: Y.Doc, by: Writer, channel: Id, insert: Id): boolean =>
  transact(
    doc,
    by,
    Option.gen(function* () {
      yield* insertNumber(insert)
      const map = yield* liveChannel(projectMaps(doc), channel)
      return write(map, 'insert', insert, master)
    })
  )

/** A parameter of the strip of an insert, the master's too, such as its volume, into the strip's range. */
export const setInsertStrip = (doc: Y.Doc, by: Writer, insert: Id, param: StripParamId, value: number): boolean =>
  transact(
    doc,
    by,
    Option.gen(function* () {
      const map = yield* insertOf(doc, insert)
      const description = yield* Option.fromUndefinedOr(strip.find(({ id }) => id === param))
      const valid = nearestIn(description, yield* finite(value))
      return write(map, param, valid, description.default)
    })
  )

/** Of one of `mixerInserts`: the master has none. */
export const setInsertMute = (doc: Y.Doc, by: Writer, insert: Id, mute: boolean): boolean =>
  transact(
    doc,
    by,
    Option.map(
      insertOf(doc, insert, (number) => number > 0),
      (map) => write(map, 'mute', mute, false)
    )
  )

/** Without the spaces around it; refused if nothing else is left. Another channel may have it too. */
export const renameChannel = (doc: Y.Doc, by: Writer, channel: Id, name: string): boolean =>
  transact(
    doc,
    by,
    Option.gen(function* () {
      const map = yield* liveChannel(projectMaps(doc), channel)
      return write(map, 'name', yield* typedName(name), '')
    })
  )

/** Marked so, all it holds left in the document: an undo brings it back whole, and an edit made in it offline stays. */
export const deleteChannel = (doc: Y.Doc, by: Writer, channel: Id): boolean =>
  transact(
    doc,
    by,
    Option.map(liveChannel(projectMaps(doc), channel), (map) => write(map, 'deleted', true, false))
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

/** The label, or else the label with the first number from 2 that names no channel: one of these is always free. */
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

/** The first name `numbered` gives, by a number from `from` on, that no name taken has: one of these is always free. */
const numberedName = (numbered: (number: number) => string, from: number, taken: ReadonlyArray<string>): string => {
  const names = new Set(taken)
  return Option.getOrElse(
    Array.findFirst(
      Array.makeBy(taken.length + 1, (i) => numbered(from + i)),
      (name) => !names.has(name)
    ),
    () => numbered(from)
  )
}

const livePatterns = (patterns: ProjectMaps['patterns']) =>
  idsOf(patterns).flatMap((id) => Option.toArray(readPatternEntry(ignore, patterns, id)))

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

/**
 * A pattern after every other, a deleted one too, named "Pattern" and the first number from 1 that no live pattern's
 * name has. Its ID; none if the document holds no project.
 */
export const addPattern = (doc: Y.Doc, by: Writer): Option.Option<Id> =>
  Option.map(Option.liftPredicate(projectMaps(doc), holdsProject), (maps) =>
    broughtIn(
      doc,
      by,
      maps.patterns,
      newMap<PatternFields>({
        name: numberedName(
          (number) => `Pattern ${number}`,
          1,
          livePatterns(maps.patterns).map(({ value }) => value.name)
        ),
        order: orderAfter(placesTaken(maps.patterns)),
        deleted: true
      })
    )
  )

/** A fractional index between `order` and the next of `orders` after it; after them all if there is none. */
const orderNext = (order: string, orders: ReadonlyArray<string>): string =>
  Option.getOrElse(
    Option.liftThrowable(() =>
      generateKeyBetween(
        order,
        Option.getOrNull(Array.findFirst(Array.sort(orders, Order.String), (taken) => taken > order))
      )
    )(),
    () => orderAfter(orders)
  )

/**
 * A copy of the pattern right after it, before any other, a deleted one too, with its notes as they read: named as a
 * clone, "Piano #2", by the first number from 2 that no live pattern's name has, and a copy of a copy by the same name;
 * after them all where its place or the next one can't be read. Its ID; none if the pattern isn't live.
 */
export const clonePattern = (doc: Y.Doc, by: Writer, pattern: Id): Option.Option<Id> => {
  const maps = projectMaps(doc)
  return Option.map(readPatternEntry(ignore, maps.patterns, pattern), ({ value, order }) => {
    const base = value.name.replace(/ #\d+$/, '')
    const notes = readNotes(patternNotes(doc, pattern))
    return broughtIn(
      doc,
      by,
      maps.patterns,
      newMap<PatternFields>({
        name: numberedName(
          (number) => `${base} #${number}`,
          2,
          livePatterns(maps.patterns).map(({ value }) => value.name)
        ),
        order: orderNext(order, placesTaken(maps.patterns)),
        deleted: true
      }),
      (id) => {
        const copied = patternNotes(doc, id)
        notes.forEach(({ channel, tick, length, key, velocity }) =>
          set(copied, newId(), { channel, tick, len: length, key, vel: velocity })
        )
      }
    )
  })
}

/** Without the spaces around it; refused if nothing else is left. Another pattern may have it too. */
export const renamePattern = (doc: Y.Doc, by: Writer, pattern: Id, name: string): boolean =>
  transact(
    doc,
    by,
    Option.gen(function* () {
      const map = yield* livePattern(projectMaps(doc), pattern)
      return write(map, 'name', yield* typedName(name), '')
    })
  )

/**
 * A live pattern but the last one: the Channels window would have no pattern to put steps in. Two clients deleting the
 * last two at once still leave none.
 */
export const canDeletePattern = (live: ReadonlyArray<Id>, pattern: Id): boolean =>
  live.length > 1 && live.includes(pattern)

/** Marked so, its notes left in the document: an undo brings it back whole. Refused as `canDeletePattern` has it. */
export const deletePattern = (doc: Y.Doc, by: Writer, pattern: Id): boolean => {
  const maps = projectMaps(doc)
  const live = idsOf(maps.patterns).filter((id) => Option.isSome(livePattern(maps, id)))
  return transact(
    doc,
    by,
    Option.gen(function* () {
      yield* Option.liftPredicate(pattern, (pattern) => canDeletePattern(live, pattern))
      const map = yield* livePattern(maps, pattern)
      return write(map, 'deleted', true, false)
    })
  )
}

/** Where a clip goes: a track of the arrangement, and the tick it starts at. */
export interface ClipPlace {
  readonly track: Id
  readonly tick: Tick
}

const placeable = ({ track }: ClipPlace) => Option.isSome(trackPlace(track))

/**
 * A clip of the live pattern at the place, brought in as a new pattern is: an undo puts it in the trash. Its ID; none if
 * the pattern isn't live, or the place is on no track.
 */
export const addClip = (doc: Y.Doc, by: Writer, pattern: Id, { track, tick }: ClipPlace): Option.Option<Id> => {
  const maps = projectMaps(doc)
  return Option.map(Option.all([livePattern(maps, pattern), Option.liftPredicate({ track, tick }, placeable)]), () =>
    broughtIn(
      doc,
      by,
      maps.clips,
      newMap<ClipFields>({
        track,
        bounds: boundsOf({ tick, ownLength: Option.none(), offset: 0 }),
        pattern,
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
 * Moves the clip to the place, writing its track and its bounds each only if the document holds otherwise. One not
 * live, or of a pattern not live, which no one sees, is refused, and so is a place a length of its own ends too late at.
 */
export const moveClip = (doc: Y.Doc, by: Writer, clip: Id, to: ClipPlace): boolean => {
  const maps = projectMaps(doc)
  return transact(
    doc,
    by,
    Option.gen(function* () {
      yield* Option.liftPredicate(to, placeable)
      const map = yield* mapAt(maps.clips, clip)
      const read = yield* readClip(ignore, maps.clips, clip)
      yield* livePattern(maps, read.pattern)
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
 * length not whole, under a tick or ending past `latestEnd` is refused, as is a clip not live, or of a pattern not live.
 */
export const resizeClip = (doc: Y.Doc, by: Writer, clip: Id, length: number): boolean => {
  const maps = projectMaps(doc)
  return transact(
    doc,
    by,
    Option.gen(function* () {
      const map = yield* mapAt(maps.clips, clip)
      const read = yield* readClip(ignore, maps.clips, clip)
      yield* livePattern(maps, read.pattern)
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
 * otherwise. A tick or an offset not whole or out of range, a length that doesn't fit, a clip not live, or of a pattern
 * not live, is refused.
 */
export const trimClip = (doc: Y.Doc, by: Writer, clip: Id, span: ClipSpan): boolean => {
  const maps = projectMaps(doc)
  return transact(
    doc,
    by,
    Option.gen(function* () {
      const map = yield* mapAt(maps.clips, clip)
      const read = yield* readClip(ignore, maps.clips, clip)
      yield* livePattern(maps, read.pattern)
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

/** Marked so, as a deleted channel is: an undo brings each back. One not live is passed over. */
export const eraseClips = (doc: Y.Doc, by: Writer, ids: ReadonlyArray<Id>): boolean => {
  const maps = projectMaps(doc)
  return transact(
    doc,
    by,
    Option.map(Option.liftPredicate(maps, holdsProject), () =>
      together(
        ids.map((id) => Option.flatMap(live(mapAt(maps.clips, id)), (map) => write(map, 'deleted', true, false)))
      )
    )
  )
}

/**
 * A channel with a synth after every other, a deleted one too, its parameters at their defaults, named after the synth
 * so that no live channel has its name: "Synth", then "Synth 2" and on. False if the document holds no project.
 */
export const addChannel = (doc: Y.Doc, by: Writer): boolean => {
  const maps = projectMaps(doc)
  return transact(
    doc,
    by,
    Option.gen(function* () {
      yield* Option.liftPredicate(maps, holdsProject)
      const live = idsOf(maps.channels).flatMap((id) => Option.toArray(readChannel(ignore, maps.channels, id)))
      const name = freeName(
        plugins.synth.label,
        live.map(({ value }) => value.name)
      )
      const order = orderAfter(placesTaken(maps.channels))
      return Option.some(() =>
        set(
          maps.channels,
          newId(),
          newMap<ChannelFields>({
            name,
            order,
            deleted: false,
            mute: false,
            instrument: newMap(newInstance(plugins.synth))
          })
        )
      )
    })
  )
}

/** A channel that plays one sound with a sampler. */
export interface NewChannel {
  readonly name: string
  readonly sound: Sha256
}

/**
 * A new project, with the ID given or one of its own: a sampler on each channel, in their order, one empty pattern, and
 * the filter on the master insert, every parameter at its default and the tempo at the engine's. False if the document
 * already holds one.
 */
export const createProject = (
  doc: Y.Doc,
  by: Writer,
  channels: ReadonlyArray<NewChannel>,
  id: Id = newId()
): boolean => {
  const maps = projectMaps(doc)
  const create = () => {
    const orders = generateNKeysBetween(null, null, channels.length)
    set(maps.meta, 'id', id)
    set(maps.meta, 'bpm', defaultTempo)
    channels.forEach(({ name, sound }, i) =>
      set(
        maps.channels,
        newId(),
        newMap<ChannelFields>({
          name,
          order: orders[i],
          deleted: false,
          mute: false,
          instrument: newMap(newInstance(plugins.sampler, { sample: sound }))
        })
      )
    )
    set(
      maps.patterns,
      newId(),
      newMap<PatternFields>({ name: 'Pattern 1', order: generateKeyBetween(null, null), deleted: false })
    )
    set(
      insertMap(doc, master),
      'slots',
      newMap({
        [newId()]: newMap<SlotFields>({
          ...newInstance(plugins.filter),
          order: generateKeyBetween(null, null),
          deleted: false
        })
      })
    )
  }
  return transact(
    doc,
    by,
    Boolean.match(holdsProject(maps), { onTrue: () => Option.none(), onFalse: () => Option.some(Option.some(create)) })
  )
}
