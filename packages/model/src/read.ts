import {
  type AnyParam,
  defaultStrip,
  defaultTempo,
  highestKey,
  lastTick,
  lowestKey,
  MidiKey,
  maxTempo,
  maxVelocity,
  minTempo,
  minVelocity,
  nearestIn,
  type ParamDescription,
  type PluginName,
  pluginNameOf,
  plugins,
  type Range,
  Sha256,
  type StripParamId,
  type StripValues,
  strip,
  Tick
} from '@escapement/engine-description'
import { Array, Boolean, Option, Order, Predicate, Schema } from 'effect'
import type * as Y from 'yjs'
import {
  type ChannelFields,
  get,
  foundInsertMap,
  idsOf,
  insertMap,
  insertName,
  insertNamed,
  type Key,
  mapAt,
  type NoteFields,
  notesName,
  type PluginFields,
  type ProjectMaps,
  patternNotes,
  projectMaps,
  type SlotFields,
  type Stored
} from './document'
import { channelStrip } from './channel-strip'
import { Id, storedId } from './id'
import { trackPlace } from './arrangement'
import { insertNumber, master } from './mixer'
import type {
  Channel,
  Clip,
  Insert,
  Master,
  Note,
  Pattern,
  PatternPlace,
  PluginInstance,
  Project,
  Slot
} from './project'
import { stepNote } from './steps'

/** A place where the document holds what reading couldn't take as it is, for the UI to point at. */
export interface Replacement {
  /** From the document's top, e.g. `['channels', id, 'instrument', 'params', 'volume']`. */
  readonly path: ReadonlyArray<string>
  readonly found: unknown
  /** What reading took instead: the default, the nearest value in range, or nothing, leaving the object out. */
  readonly read: 'default' | 'nearest' | 'skipped'
}

/** A value read from a document, and every replacement made reading it. The document itself is never changed. */
export interface Read<A> {
  readonly value: A
  readonly replacements: ReadonlyArray<Replacement>
}

type Path = ReadonlyArray<string>

/** Where reading tells of a replacement. */
export type Report = (replacement: Replacement) => void

/** For reading that only needs the values. */
export const ignore: Report = () => {}

/** The tick after the last: where the latest note can end. */
export const latestEnd = lastTick + 1

export const finite = Schema.decodeUnknownOption(Schema.Finite)
const string = Schema.decodeUnknownOption(Schema.String)
const boolean = Schema.decodeUnknownOption(Schema.Boolean)
const identifier = Schema.decodeUnknownOption(storedId)
const sha256 = Schema.decodeUnknownOption(Schema.String.pipe(Schema.fromBrand('Sha256', Sha256)))
const pluginRef = Schema.decodeUnknownOption(Schema.Struct({ id: Schema.Int, version: Schema.Int }))
/** What makes a note itself; the rest has defaults. */
const NoteFieldsRead = Schema.Struct({
  channel: Schema.NonEmptyString,
  tick: Schema.Finite,
  len: Schema.optionalKey(Schema.Unknown),
  key: Schema.optionalKey(Schema.Unknown),
  vel: Schema.optionalKey(Schema.Unknown)
})
type NoteFieldsRead = typeof NoteFieldsRead.Type
const noteFields = Schema.decodeUnknownOption(NoteFieldsRead)
/** What makes a clip itself: no default puts it on a track, in time, or says what it plays. */
const clipFields = Schema.decodeUnknownOption(
  Schema.Struct({
    track: Schema.NonEmptyString,
    bounds: Schema.Struct({
      tick: Schema.Finite,
      length: Schema.optionalKey(Schema.Unknown),
      offset: Schema.optionalKey(Schema.Unknown)
    }),
    pattern: Schema.NonEmptyString
  })
)

/** Reports what was read otherwise than found, if it was. */
const reportWhen = (report: Report, happened: boolean, replacement: Replacement) =>
  Boolean.match(happened, { onTrue: () => report(replacement), onFalse: () => {} })

/** Nothing there is the default as it is: a document older than the field. Anything but an `A` is reported. */
const valueOr =
  <A>(decode: (found: unknown) => Option.Option<A>) =>
  (report: Report, path: Path, found: unknown, fallback: A): A =>
    Option.match(Option.fromUndefinedOr(found), {
      onNone: () => fallback,
      onSome: (found) =>
        Option.getOrElse(decode(found), () => {
          report({ path, found, read: 'default' })
          return fallback
        })
    })

const stringOr = valueOr(string)
const booleanOr = valueOr(boolean)
const finiteOr = valueOr(finite)
/** The ID of an insert there is. */
const insertOr = valueOr((found) => Option.filter(identifier(found), (id) => Option.isSome(insertNumber(id))))

/** A number past the range reads as the nearest one in it, and a whole one as the nearest whole number. */
const numberOr = (report: Report, path: Path, found: unknown, range: Range, fallback: number): number => {
  const value = finiteOr(report, path, found, fallback)
  const nearest = nearestIn(range, value)
  reportWhen(report, nearest !== value, { path, found, read: 'nearest' })
  return nearest
}

/** The map the layout puts under `key`; something else there is reported as `read`, and so is nothing if `required`. */
const mapUnder = <F, K extends Key<F>>(
  report: Report,
  path: Path,
  map: Stored<F>,
  key: K,
  read: 'default' | 'skipped',
  required = false
): Option.Option<F[K] & Y.Map<unknown>> => {
  const found = mapAt(map, key)
  const there = get(map, key)
  reportWhen(report, Option.isNone(found) && (there !== undefined || required), {
    path: [...path, key],
    found: there,
    read
  })
  return found
}

export const isDeleted = (map: Stored<{ readonly deleted: boolean }>, report: Report = ignore, path: Path = []) =>
  booleanOr(report, [...path, 'deleted'], get(map, 'deleted'), false)

/** The plugin the map names, if this build has it. */
export const readPluginName = (map: Stored<PluginFields>): Option.Option<PluginName> =>
  Option.flatMap(pluginRef(get(map, 'plugin')), ({ id, version }) => pluginNameOf(id, version))

/** Every parameter of the plugin and every sample with a sound; none for a plugin this build doesn't have. */
export const readInstance = (
  map: Stored<PluginFields>,
  report: Report = ignore,
  path: Path = []
): Option.Option<PluginInstance> => {
  return Option.map(readPluginName(map), (name) => instanceOf(name, map, report, path)).pipe(
    Option.orElse(() => {
      report({ path: [...path, 'plugin'], found: get(map, 'plugin'), read: 'skipped' })
      return Option.none()
    })
  )
}

/** The named plugin's instance, from its own description: its parameters and samples, and no other. */
const instanceOf = (name: PluginName, map: Stored<PluginFields>, report: Report, path: Path): PluginInstance => {
  const plugin = plugins[name]
  const params: ReadonlyArray<ParamDescription> = plugin.params
  const samples: ReadonlyArray<{ readonly id: string }> = plugin.samples
  const values = mapUnder(report, path, map, 'params', 'default')
  const sounds = mapUnder(report, path, map, 'samples', 'default')
  return {
    name,
    plugin,
    params: Object.fromEntries(
      params.map((param) => [
        param.id,
        Option.match(values, {
          onNone: () => param.default,
          onSome: (stored) =>
            numberOr(report, [...path, 'params', param.id], get(stored, param.id), param, param.default)
        })
      ])
    ),
    samples: Object.fromEntries(
      samples.flatMap(({ id }) =>
        Option.match(
          // Nothing there is no sound; anything else that isn't one is reported.
          Option.flatMap(sounds, (stored) => Option.fromUndefinedOr(get(stored, id))),
          {
            onNone: () => [],
            onSome: (found) =>
              Option.match(sha256(found), {
                onNone: () => {
                  report({ path: [...path, 'samples', id], found, read: 'default' })
                  return []
                },
                onSome: (hash) => [[id, hash]]
              })
          }
        )
      )
    )
  } as PluginInstance
}

/** None for one without a channel or a tick: no default puts it anywhere. It ends by `latestEnd`. */
export const readNote = (id: Id, found: unknown, report: Report = ignore, path: Path = []): Option.Option<Note> =>
  Option.flatMap(noteFields(found), (fields) => {
    const tick = Math.round(fields.tick)
    return Option.map(
      Option.liftPredicate(tick, (tick) => tick >= 0 && tick <= lastTick),
      (tick) => noteOf(id, fields, tick, report, path)
    )
  }).pipe(
    Option.orElse(() => {
      report({ path, found, read: 'skipped' })
      return Option.none()
    })
  )

/** A note with a tick in the pattern: the rest of its fields read into range. */
const noteOf = (id: Id, fields: NoteFieldsRead, tick: number, report: Report, path: Path): Note => {
  reportWhen(report, tick !== fields.tick, { path: [...path, 'tick'], found: fields.tick, read: 'nearest' })
  const length = { min: 1, max: latestEnd - tick, whole: true }
  const key = { min: lowestKey, max: highestKey, whole: true }
  const velocity = { min: minVelocity, max: maxVelocity }
  return {
    id,
    channel: Id(fields.channel),
    tick: Tick(tick),
    length: numberOr(report, [...path, 'len'], fields.len, length, stepNote.length),
    key: MidiKey(numberOr(report, [...path, 'key'], fields.key, key, stepNote.key)),
    velocity: numberOr(report, [...path, 'vel'], fields.vel, velocity, stepNote.velocity)
  }
}

const byId = Order.mapInput(Order.String, ({ id }: { readonly id: Id }) => id)

/** Every note that has a channel and a tick, by ID. */
export const readNotes = (
  notes: Stored<Record<string, NoteFields>>,
  report: Report = ignore,
  path: Path = []
): ReadonlyArray<Note> =>
  Array.sort(
    idsOf(notes).flatMap((id) => Option.toArray(readNote(id, get(notes, id), report, [...path, id]))),
    byId
  )

export interface Ordered<A> {
  readonly order: string
  readonly value: A
}

/** By fractional index, and by ID where two clients picked the same one. */
export const inOrder = <A extends { readonly id: Id }>(entries: ReadonlyArray<Ordered<A>>): ReadonlyArray<A> =>
  Array.sort(
    entries,
    Order.combine<Ordered<A>>(
      Order.mapInput(Order.String, ({ order }) => order),
      Order.mapInput(byId, ({ value }) => value)
    )
  ).map(({ value }) => value)

/** The live map under `id`; one that isn't a map is reported. */
const liveEntry = <F extends { readonly deleted: boolean }>(
  report: Report,
  path: Path,
  map: Stored<Record<string, Stored<F>>>,
  id: Id
): Option.Option<Stored<F>> =>
  Option.filter(mapUnder(report, path, map, id, 'skipped'), (entry) => !isDeleted(entry, report, [...path, id]))

/** Every parameter of a strip of these descriptions, from the map's keys of their IDs. */
const readStrip = (
  map: Stored<Partial<StripValues>>,
  params: ReadonlyArray<AnyParam & { readonly id: StripParamId }>,
  report: Report,
  path: Path
): StripValues =>
  Object.fromEntries(
    params.map((param) => [param.id, numberOr(report, [...path, param.id], get(map, param.id), param, param.default)])
  ) as StripValues

export const readChannel = (
  report: Report,
  channels: Stored<Record<string, Stored<ChannelFields>>>,
  id: Id
): Option.Option<Ordered<Channel>> =>
  Option.map(liveEntry(report, ['channels'], channels, id), (map) => {
    const path = ['channels', id]
    return {
      value: {
        id,
        name: stringOr(report, [...path, 'name'], get(map, 'name'), ''),
        mute: booleanOr(report, [...path, 'mute'], get(map, 'mute'), false),
        strip: readStrip(map, channelStrip, report, path),
        instrument: Option.flatMap(mapUnder(report, path, map, 'instrument', 'skipped', true), (instrument) =>
          readInstance(instrument, report, [...path, 'instrument'])
        ),
        insert: insertOr(report, [...path, 'insert'], get(map, 'insert'), master)
      },
      order: stringOr(report, [...path, 'order'], get(map, 'order'), '')
    }
  })

/** A live pattern but its notes, which are a map of their own. */
export const readPatternEntry = (
  report: Report,
  patterns: ProjectMaps['patterns'],
  id: Id
): Option.Option<Ordered<Omit<Pattern, 'notes'>>> =>
  Option.map(liveEntry(report, ['patterns'], patterns, id), (map) => {
    const path = ['patterns', id]
    return {
      value: { id, name: stringOr(report, [...path, 'name'], get(map, 'name'), '') },
      order: stringOr(report, [...path, 'order'], get(map, 'order'), '')
    }
  })

export const readPatternPlace = (patterns: ProjectMaps['patterns'], id: Id): Option.Option<Ordered<PatternPlace>> =>
  Option.map(mapUnder(ignore, ['patterns'], patterns, id, 'skipped'), (map) => ({
    value: { id, live: !isDeleted(map) },
    order: stringOr(ignore, ['patterns', id, 'order'], get(map, 'order'), '')
  }))

export const readPatternNotes = (doc: Y.Doc, id: Id, report: Report = ignore) =>
  readNotes(patternNotes(doc, id), report, [notesName(id)])

export const readPattern = (report: Report, doc: Y.Doc, id: Id): Option.Option<Ordered<Pattern>> =>
  Option.map(readPatternEntry(report, projectMaps(doc).patterns, id), ({ value, order }) => ({
    value: { ...value, notes: readPatternNotes(doc, id, report) },
    order
  }))

/** How far into its pattern's rounds a clip may start: whole, no further either way than the last tick. */
const clipOffset = { min: -lastTick, max: lastTick, whole: true }

/**
 * A clip's own length, whole and ending by `latestEnd`, as near as it can be; none while it has none, and for one that
 * isn't a number, which is reported: the clip is then as long as its pattern.
 */
const clipLength = (report: Report, path: Path, found: unknown, tick: number): Option.Option<number> =>
  Option.flatMap(Option.fromUndefinedOr(found), (found) =>
    Option.match(finite(found), {
      onNone: () => {
        report({ path, found, read: 'default' })
        return Option.none()
      },
      onSome: (value) => {
        const nearest = nearestIn({ min: 1, max: latestEnd - tick, whole: true }, value)
        reportWhen(report, nearest !== value, { path, found, read: 'nearest' })
        return Option.some(nearest)
      }
    })
  )

/**
 * A live clip of a pattern on one of the arrangement's tracks, from a tick in range, the nearest whole one; none for
 * one without them.
 */
export const readClip = (report: Report, clips: ProjectMaps['clips'], id: Id): Option.Option<Clip> =>
  Option.flatMap(liveEntry(report, ['clips'], clips, id), (map) => {
    const path = ['clips', id]
    const found = { track: get(map, 'track'), bounds: get(map, 'bounds'), pattern: get(map, 'pattern') }
    return Option.flatMap(clipFields(found), ({ track, bounds, pattern }) => {
      const tick = Math.round(bounds.tick)
      return Option.map(
        Option.all({
          track: Option.liftPredicate(Id(track), (track) => Option.isSome(trackPlace(track))),
          tick: Option.liftPredicate(tick, (tick) => tick >= 0 && tick <= lastTick)
        }),
        ({ track, tick }): Clip => {
          reportWhen(report, tick !== bounds.tick, { path: [...path, 'bounds'], found: bounds, read: 'nearest' })
          const ownLength = clipLength(report, [...path, 'bounds', 'length'], bounds.length, tick)
          const offset = numberOr(report, [...path, 'bounds', 'offset'], bounds.offset, clipOffset, 0)
          return { id, track, tick: Tick(tick), pattern: Id(pattern), ownLength, offset }
        }
      )
    }).pipe(
      Option.orElse(() => {
        report({ path, found, read: 'skipped' })
        return Option.none()
      })
    )
  })

/**
 * The clips of the live patterns given, by ID. What is replaced reading one is told unless it names a pattern not live,
 * which no one sees, as a deleted pattern's notes aren't read.
 */
export const readClips = (
  report: Report,
  clips: ProjectMaps['clips'],
  patterns: ReadonlyArray<Id>
): ReadonlyArray<Clip> => {
  const live = new Set<unknown>(patterns)
  const seen = (id: Id) =>
    Option.match(mapAt(clips, id), {
      onNone: () => true,
      onSome: (map) => !Predicate.isString(get(map, 'pattern')) || live.has(get(map, 'pattern'))
    })
  return Array.sort(
    idsOf(clips).flatMap((id) =>
      Option.toArray(
        Option.filter(
          readClip(Boolean.match(seen(id), { onTrue: () => report, onFalse: () => ignore }), clips, id),
          ({ pattern }) => live.has(pattern)
        )
      )
    ),
    byId
  )
}

/** A slot whose plugin this build doesn't have is left out. */
const readSlot = (
  report: Report,
  path: Path,
  slots: Stored<Record<string, Stored<SlotFields>>>,
  id: Id
): Option.Option<Ordered<Slot>> =>
  Option.flatMap(liveEntry(report, path, slots, id), (map) =>
    Option.map(readInstance(map, report, [...path, id]), (instance) => ({
      value: { ...instance, id },
      order: stringOr(report, [...path, id, 'order'], get(map, 'order'), '')
    }))
  )

/** Its slots missing or broken, it has none: the sound goes straight out. */
export const readMaster = (report: Report, doc: Y.Doc): Master => {
  const map = insertMap(doc, master)
  const path = [insertName(master)]
  const slots = mapUnder(report, path, map, 'slots', 'default')
  return {
    strip: readStrip(map, strip, report, path),
    slots: Option.match(slots, {
      onNone: () => [],
      onSome: (found) =>
        inOrder(idsOf(found).flatMap((id) => Option.toArray(readSlot(report, [...path, 'slots'], found, id))))
    })
  }
}

/** One of `mixerInserts`: at its defaults while the document holds nothing of it. */
export const readInsert = (report: Report, doc: Y.Doc, id: Id): Insert =>
  Option.match(foundInsertMap(doc, id), {
    onNone: () => ({ id, strip: defaultStrip, mute: false }),
    onSome: (map) => {
      const path = [insertName(id)]
      return {
        id,
        strip: readStrip(map, strip, report, path),
        mute: booleanOr(report, [...path, 'mute'], get(map, 'mute'), false)
      }
    }
  })

const byNumber = Order.mapInput(Order.Number, ({ number }: { readonly number: number }) => number)

/** The inserts besides the master that the document holds anything of, by their number. */
const readInserts = (report: Report, doc: Y.Doc): ReadonlyArray<Insert> =>
  Array.sort(
    Array.fromIterable(doc.share.keys()).flatMap((name) =>
      Option.toArray(
        Option.flatMap(insertNamed(name), (id) =>
          Option.map(
            Option.filter(insertNumber(id), (number) => number > 0 && insertMap(doc, id).size > 0),
            (number) => ({ id, number })
          )
        )
      )
    ),
    byNumber
  ).map(({ id }) => readInsert(report, doc, id))

export const readTempo = (report: Report, meta: ProjectMaps['meta']) =>
  numberOr(report, ['meta', 'bpm'], get(meta, 'bpm'), { min: minTempo, max: maxTempo }, defaultTempo)

/** The ID the project was made with; none in a project made before projects had one, or with something else there. */
export const readProjectId = (doc: Y.Doc): Option.Option<Id> => identifier(get(projectMaps(doc).meta, 'id'))

export const readProject = (doc: Y.Doc): Read<Project> => {
  const replacements: Array<Replacement> = []
  const report: Report = (replacement) => {
    replacements.push(replacement)
  }
  const { meta, channels, patterns, clips } = projectMaps(doc)
  // Replacements are told in the order of the project's parts.
  const tempo = readTempo(report, meta)
  const channelsRead = inOrder(idsOf(channels).flatMap((id) => Option.toArray(readChannel(report, channels, id))))
  const patternsRead = inOrder(idsOf(patterns).flatMap((id) => Option.toArray(readPattern(report, doc, id))))
  const value: Project = {
    tempo,
    channels: channelsRead,
    patterns: patternsRead,
    clips: readClips(
      report,
      clips,
      patternsRead.map(({ id }) => id)
    ),
    master: readMaster(report, doc),
    inserts: readInserts(report, doc)
  }
  return { value, replacements }
}
