import {
  type AnyParam,
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
import { firstColour, storedColour } from './colour'
import {
  get,
  idsOf,
  type Key,
  mapAt,
  type NoteFields,
  notesName,
  type PluginFields,
  type ProjectMaps,
  patternNotes,
  projectMaps,
  type SlotFields,
  type Stored,
  type TrackFields
} from './document'
import { Id, storedId } from './id'
import type { Clip, Master, Note, Pattern, PluginInstance, Project, Slot, Track } from './project'
import { defaultNote } from './time'
import { trackStrip } from './track-strip'

/** A place where the document holds what reading couldn't take as it is, for the UI to point at. */
export interface Replacement {
  /** From the document's top, e.g. `['tracks', id, 'instrument', 'params', 'volume']`. */
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
export const colour = Schema.decodeUnknownOption(storedColour)
const sha256 = Schema.decodeUnknownOption(Schema.String.pipe(Schema.fromBrand('Sha256', Sha256)))
const pluginRef = Schema.decodeUnknownOption(Schema.Struct({ id: Schema.Int, version: Schema.Int }))
/** What makes a note itself; the rest has defaults. */
const NoteFieldsRead = Schema.Struct({
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
const colourOr = valueOr(colour)

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

/** None for one without a tick: no default puts it anywhere. It ends by `latestEnd`. */
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
    tick: Tick(tick),
    length: numberOr(report, [...path, 'len'], fields.len, length, defaultNote.length),
    key: MidiKey(numberOr(report, [...path, 'key'], fields.key, key, defaultNote.key)),
    velocity: numberOr(report, [...path, 'vel'], fields.vel, velocity, defaultNote.velocity)
  }
}

const byId = Order.mapInput(Order.String, ({ id }: { readonly id: Id }) => id)

/** Every note that has a tick, by ID. */
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

export const readTrack = (
  report: Report,
  tracks: Stored<Record<string, Stored<TrackFields>>>,
  id: Id
): Option.Option<Ordered<Track>> =>
  Option.map(liveEntry(report, ['tracks'], tracks, id), (map) => {
    const path = ['tracks', id]
    return {
      value: {
        id,
        name: stringOr(report, [...path, 'name'], get(map, 'name'), ''),
        colour: colourOr(report, [...path, 'colour'], get(map, 'colour'), firstColour),
        mute: booleanOr(report, [...path, 'mute'], get(map, 'mute'), false),
        strip: readStrip(map, trackStrip, report, path),
        instrument: Option.flatMap(mapUnder(report, path, map, 'instrument', 'skipped', true), (instrument) =>
          readInstance(instrument, report, [...path, 'instrument'])
        )
      },
      order: stringOr(report, [...path, 'order'], get(map, 'order'), '')
    }
  })

export const readPatternNotes = (doc: Y.Doc, id: Id, report: Report = ignore) =>
  readNotes(patternNotes(doc, id), report, [notesName(id)])

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
 * A live clip, on a track and of a pattern by their IDs, from a tick in range, the nearest whole one; none for one
 * without them.
 */
export const readClip = (report: Report, clips: ProjectMaps['clips'], id: Id): Option.Option<Clip> =>
  Option.flatMap(liveEntry(report, ['clips'], clips, id), (map) => {
    const path = ['clips', id]
    const found = { track: get(map, 'track'), bounds: get(map, 'bounds'), pattern: get(map, 'pattern') }
    return Option.flatMap(clipFields(found), ({ track, bounds, pattern }) =>
      Option.map(
        Option.liftPredicate(Math.round(bounds.tick), (tick) => tick >= 0 && tick <= lastTick),
        (tick): Clip => {
          reportWhen(report, tick !== bounds.tick, { path: [...path, 'bounds'], found: bounds, read: 'nearest' })
          const ownLength = clipLength(report, [...path, 'bounds', 'length'], bounds.length, tick)
          const offset = numberOr(report, [...path, 'bounds', 'offset'], bounds.offset, clipOffset, 0)
          return { id, track: Id(track), tick: Tick(tick), pattern: Id(pattern), ownLength, offset }
        }
      )
    ).pipe(
      Option.orElse(() => {
        report({ path, found, read: 'skipped' })
        return Option.none()
      })
    )
  })

/**
 * The clips on the live tracks given, by ID. What is replaced reading one is told unless it is on a track not live,
 * which no one sees, as a deleted track's clips are hidden with it.
 */
export const readClips = (
  report: Report,
  clips: ProjectMaps['clips'],
  tracks: ReadonlyArray<Id>
): ReadonlyArray<Clip> => {
  const live = new Set<unknown>(tracks)
  const seen = (id: Id) =>
    Option.match(mapAt(clips, id), {
      onNone: () => true,
      onSome: (map) => !Predicate.isString(get(map, 'track')) || live.has(get(map, 'track'))
    })
  return Array.sort(
    idsOf(clips).flatMap((id) =>
      Option.toArray(
        Option.filter(
          readClip(Boolean.match(seen(id), { onTrue: () => report, onFalse: () => ignore }), clips, id),
          ({ track }) => live.has(track)
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
export const readMaster = (report: Report, map: ProjectMaps['master']): Master => {
  const path = ['master']
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

export const readTempo = (report: Report, meta: ProjectMaps['meta']) =>
  numberOr(report, ['meta', 'bpm'], get(meta, 'bpm'), { min: minTempo, max: maxTempo }, defaultTempo)

/** The ID the project was made with; none in a project made before projects had one, or with something else there. */
export const readProjectId = (doc: Y.Doc): Option.Option<Id> => identifier(get(projectMaps(doc).meta, 'id'))

export const readProject = (doc: Y.Doc): Read<Project> => {
  const replacements: Array<Replacement> = []
  const report: Report = (replacement) => {
    replacements.push(replacement)
  }
  const { meta, tracks, clips, master } = projectMaps(doc)
  // Replacements are told in the order of the project's parts.
  const tempo = readTempo(report, meta)
  const tracksRead = inOrder(idsOf(tracks).flatMap((id) => Option.toArray(readTrack(report, tracks, id))))
  const clipsRead = readClips(
    report,
    clips,
    tracksRead.map(({ id }) => id)
  )
  const patterns = Array.sort(Array.dedupe(clipsRead.map(({ pattern }) => pattern)), Order.String).map(
    (id): Pattern => ({ id, notes: readPatternNotes(doc, id, report) })
  )
  const value: Project = {
    tempo,
    tracks: tracksRead,
    clips: clipsRead,
    patterns,
    master: readMaster(report, master)
  }
  return { value, replacements }
}
