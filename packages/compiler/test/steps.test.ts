import { blocks, pageSounds, sampleRate, startEngine, type TestEngine } from '@escapement/engine/testing'
import { paramValue, plugins, Sha256, strip, Tick, ticksPerQuarter } from '@escapement/engine-description'
import {
  batchedState,
  defaultNote,
  deleteTrack,
  followProject,
  HoldTarget,
  type Holds,
  heldValue,
  holding,
  type Id,
  type Listening,
  lettingGo,
  newWriter,
  noHolds,
  noAuditions,
  newListening,
  type Auditions,
  insertOfNumber,
  readProject,
  resizeClip,
  setInsertMute,
  setInsertStrip,
  setMasterParam,
  setMute,
  setTempo,
  setTrackInsert,
  setTrackParam,
  setTrackStrip,
  barTicks,
  barSteps,
  stepTicks,
  toggledSolo,
  trimClip
} from '@escapement/model'
import { Arbitrary, Array, Boolean, Config, Effect, Match, Option, Order, Schema } from 'effect'
import { Atom, AtomRegistry } from 'effect/reactivity'
import { it } from '@effect/vitest'
import * as Y from 'yjs'
import { compile, type SoundLibrary } from '../src'

const by = newWriter('test')

const between = (minimum: number, maximum: number) => Schema.Int.check(Schema.isBetween({ minimum, maximum }))
/** Of the live ones, as many times round as it takes. */
const which = between(0, 7)
const order = between(0, 99)
const tenths = between(0, 10)
/** Down to about 600 Hz: a filter further down would silence the run. */
const opening = between(5, 10)
const sound = between(0, 3)
const step = between(0, barSteps - 1)
/** Edits the engine sleeps through. */
const asleepFor = between(1, 3)
/** Edits it sleeps through first, if any. */
const asleepFirst = between(0, 3)
/** A parameter of a track's strip, by its place. */
const stripParam = between(0, strip.length - 1)
const [synthShape] = plugins.synth.params
/** A synth's shape by its place, any but noise: each note's noise is its own, so a pattern played again differs. */
const shape = Schema.Literals(
  synthShape.choices.flatMap(({ id }, place) => Option.toArray(Option.liftPredicate(place, () => id !== 'noise')))
)
/** A synth's shapes, an oscillator's each, and its knobs: their tuning and mixes. */
const synthShapes = plugins.synth.params.filter(({ choices }) => choices !== null)
const synthKnobs = plugins.synth.params.filter(({ choices }) => choices === null)
const oscillator = between(0, synthShapes.length - 1)
const synthKnob = between(0, synthKnobs.length - 1)
/** An insert by its number, 0 the master: a few, so tracks share some. */
const insert = between(0, 3)

/**
 * What other clients and this one may do to a project, some of it with nothing in the page that does it yet, how this
 * one listens to it, the controls it holds, whether its engine runs, and a rebuild.
 */
const DocumentEdit = Schema.Union([
  Schema.TaggedStruct('ToggleNote', { pattern: which, step }),
  Schema.TaggedStruct('SetShape', { track: which, oscillator, shape }),
  Schema.TaggedStruct('SetSynthKnob', { track: which, knob: synthKnob, position: tenths }),
  Schema.TaggedStruct('SetStrip', { track: which, param: stripParam, position: tenths }),
  Schema.TaggedStruct('SetCutoff', { slot: which, position: opening }),
  Schema.TaggedStruct('SetTempo', { tempo: tenths }),
  Schema.TaggedStruct('AddTrack', { sound, order, step, synth: Schema.Boolean }),
  Schema.TaggedStruct('DeleteTrack', { track: which, remove: Schema.Boolean }),
  Schema.TaggedStruct('RestoreTrack', { track: which }),
  Schema.TaggedStruct('SetSound', { track: which, sound }),
  Schema.TaggedStruct('AddSlot', { order, position: opening }),
  Schema.TaggedStruct('DeleteSlot', { slot: which, remove: Schema.Boolean }),
  Schema.TaggedStruct('MoveSlot', { slot: which, order }),
  // Of a pattern a clip plays already, as a client of a later build may put a copy that plays it too.
  Schema.TaggedStruct('PutClip', { pattern: which, track: which, step }),
  Schema.TaggedStruct('MoveClip', { clip: which, track: which, step }),
  Schema.TaggedStruct('ResizeClip', { clip: which, steps: between(1, 3 * barSteps) }),
  Schema.TaggedStruct('TrimClip', {
    clip: which,
    step,
    steps: between(1, 3 * barSteps),
    offset: between(-2 * barSteps, 2 * barSteps)
  }),
  Schema.TaggedStruct('DeleteClip', { clip: which, remove: Schema.Boolean }),
  Schema.TaggedStruct('SetMute', { track: which, mute: Schema.Boolean }),
  Schema.TaggedStruct('SetInsert', { track: which, insert }),
  Schema.TaggedStruct('SetInsertStrip', { insert, param: stripParam, position: tenths }),
  Schema.TaggedStruct('SetInsertMute', { insert, mute: Schema.Boolean }),
  Schema.TaggedStruct('HoldInsert', { track: which, insert }),
  Schema.TaggedStruct('HoldInsertStrip', { insert, param: stripParam, position: tenths }),
  Schema.TaggedStruct('ToggleSolo', { track: which }),
  Schema.TaggedStruct('HoldShape', { track: which, oscillator, shape }),
  Schema.TaggedStruct('HoldSynthKnob', { track: which, knob: synthKnob, position: tenths }),
  Schema.TaggedStruct('HoldStrip', { track: which, param: stripParam, position: tenths }),
  Schema.TaggedStruct('HoldCutoff', { slot: which, position: opening }),
  Schema.TaggedStruct('HoldTempo', { tempo: tenths }),
  Schema.TaggedStruct('LetGo', { hold: between(0, 3) }),
  Schema.TaggedStruct('Sleep', { edits: asleepFor }),
  Schema.TaggedStruct('Rebuild', {})
])
type DocumentEdit = typeof DocumentEdit.Type

/** Three sounds of the library, and one it doesn't have. */
const hashes = [0, 1, 2, 3].map((i) => Sha256(`${i}e`.repeat(32)))

/** A short sound for each, unlike the others: a decay at its own pitch, made anew since a stored one goes over. */
const pcmOf = (i: number) => ({
  sampleRate,
  channels: [Float32Array.from({ length: 600 }, (_, frame) => Math.sin(frame * (i + 1) * 0.05) * 0.5 ** (frame / 150))]
})

const library: SoundLibrary = {
  load: (hash) =>
    Option.liftPredicate(hashes.indexOf(hash), (i) => i >= 0 && i !== 3).pipe(
      Option.map((i) => Effect.sync(() => pcmOf(i)))
    ),
  show: () => Effect.void
}

const cutoff = plugins.filter.params[0]

const ordered = (n: number) => String(n).padStart(2, '0')

const plugin = (of: { readonly id: number; readonly version: number }) => ({ id: of.id, version: of.version })

const mapOf = (fields: Record<string, unknown>) => new Y.Map<unknown>(Object.entries(fields))

/** A sampler playing the sound, or a synth: only a synth has a parameter of its own to set or hold. */
const instrumentOf = (hash: Sha256, synth: boolean) =>
  Boolean.match(synth, {
    onTrue: () => mapOf({ plugin: plugin(plugins.synth), params: mapOf({}), samples: mapOf({}) }),
    onFalse: () => mapOf({ plugin: plugin(plugins.sampler), params: mapOf({}), samples: mapOf({ sample: hash }) })
  })

const trackOf = (hash: Sha256, at: number, synth: boolean) =>
  mapOf({ name: 'Drum', order: ordered(at), deleted: false, mute: false, instrument: instrumentOf(hash, synth) })

const slotOf = (at: number, position: number) =>
  mapOf({
    plugin: plugin(plugins.filter),
    params: mapOf({ cutoff: paramValue(cutoff, position / 10) }),
    samples: mapOf({}),
    order: ordered(at),
    deleted: false
  })

/** A note on the step, as the page puts one there. */
const noteOf = (step: number) => ({
  tick: step * stepTicks,
  len: defaultNote.length,
  key: defaultNote.key,
  vel: defaultNote.velocity
})

/** The pattern's notes, a map of the document's top. */
const notesOf = (doc: Y.Doc, pattern: string) => doc.getMap(`notes/${pattern}`)

/** A clip of the pattern on the track, from the step: within the bar a run plays. */
const clipOf = (track: string, pattern: string, step: number) =>
  mapOf({ track, bounds: { tick: step * stepTicks }, pattern, deleted: false })

/** A project as another client writes it: IDs from a count, so a run is the same each time. */
const newDocument = () => {
  const doc = new Y.Doc()
  doc.transact(() => {
    doc.getMap('meta').set('bpm', 120)
    // A drum and a synth, each with a clip of a pattern of its own.
    doc.getMap('tracks').set('t1', trackOf(hashes[0], 10, false))
    doc.getMap('tracks').set('t2', trackOf(hashes[1], 20, true))
    doc.getMap('clips').set('k1', clipOf('t1', 'p1', 0))
    doc.getMap('clips').set('k2', clipOf('t2', 'p2', 0))
    notesOf(doc, 'p1').set('n1', noteOf(0))
    notesOf(doc, 'p1').set('n2', noteOf(2))
    notesOf(doc, 'p2').set('n3', noteOf(5))
    doc.getMap('mixer/master').set('slots', mapOf({ s1: slotOf(50, 10) }))
  })
  const made = { count: 2 }
  const nextId = (prefix: string) => {
    made.count += 1
    return `${prefix}${made.count}`
  }
  return { doc, nextId }
}

/** The map under each key in turn: the edits reach only into what the test wrote. */
const mapIn = (map: Y.Map<unknown>, ...keys: ReadonlyArray<string>) =>
  keys.reduce((inner, key) => inner.get(key) as Y.Map<unknown>, map)

const slots = (doc: Y.Doc) => mapIn(doc.getMap('mixer/master'), 'slots')

/** Each track marked deleted, by ID. */
const deletedTracks = (doc: Y.Doc) =>
  Array.sort(
    Array.fromIterable(doc.getMap('tracks').entries()).flatMap(([id, map]) =>
      Option.toArray(Option.liftPredicate(id, () => map instanceof Y.Map && map.get('deleted') === true))
    ),
    Order.String
  )

/** The live one the edit means; none if there are none. */
const picked = <A>(live: ReadonlyArray<A>, n: number) => Option.fromUndefinedOr(live[n % Math.max(live.length, 1)])

/**
 * What this client changes apart from the document: its solo, the controls it holds and lets go, whether its engine runs,
 * and a rebuild.
 */
interface Local {
  readonly solo: (track: Id) => void
  readonly hold: (target: HoldTarget, value: number) => void
  /** The held one the edit means, if any. */
  readonly letGo: (n: number) => void
  /** The engine sleeps through the next edits, as a paused context does, and then wakes, as Play wakes it. */
  readonly sleep: (edits: number) => void
}

/**
 * One transaction, as a client writes it, or a change of how it listens or what it holds; an edit with nothing to act
 * on does nothing.
 */
const applied = (
  { doc, nextId }: ReturnType<typeof newDocument>,
  local: Local,
  edit: Exclude<DocumentEdit, { readonly _tag: 'Rebuild' }>
) => {
  const { tracks, patterns, master, clips } = readProject(doc).value
  const track = (n: number) => Option.map(picked(tracks, n), ({ id }) => id)
  const clip = (n: number) => Option.map(picked(clips, n), ({ id }) => id)
  const pattern = (n: number) => Option.map(picked(patterns, n), ({ id }) => id)
  const slot = (n: number) => Option.map(picked(master.slots, n), ({ id }) => id)
  const gone = (map: Y.Map<unknown>, id: Id, remove: boolean) =>
    doc.transact(() =>
      Boolean.match(remove, { onTrue: () => map.delete(id), onFalse: () => void mapIn(map, id).set('deleted', true) })
    )
  return Match.valueTags(edit, {
    // Off if a note starts on the step, whatever its key; on otherwise.
    ToggleNote: (edit) =>
      Option.map(pattern(edit.pattern), (id) =>
        doc.transact(() => {
          const notes = notesOf(doc, id)
          const on = Array.fromIterable(notes.entries()).flatMap(([key, note]) =>
            Option.toArray(
              Option.liftPredicate(key, () => (note as { readonly tick?: unknown }).tick === edit.step * stepTicks)
            )
          )
          Array.match(on, {
            onEmpty: () => notes.set(nextId('n'), noteOf(edit.step)),
            onNonEmpty: (on) => on.forEach((key) => notes.delete(key))
          })
        })
      ),
    SetShape: (edit) =>
      Option.map(track(edit.track), (id) => setTrackParam(doc, by, id, synthShapes[edit.oscillator].id, edit.shape)),
    SetSynthKnob: (edit) =>
      Option.map(track(edit.track), (id) =>
        setTrackParam(doc, by, id, synthKnobs[edit.knob].id, paramValue(synthKnobs[edit.knob], edit.position / 10))
      ),
    SetStrip: (edit) =>
      Option.map(track(edit.track), (id) =>
        setTrackStrip(doc, by, id, strip[edit.param].id, paramValue(strip[edit.param], edit.position / 10))
      ),
    SetCutoff: (edit) =>
      Option.map(slot(edit.slot), (id) =>
        setMasterParam(doc, by, id, 'cutoff', paramValue(cutoff, edit.position / 10))
      ),
    SetTempo: (edit) => setTempo(doc, by, 120 + edit.tempo * 12),
    // With a clip from the start, of a pattern of its own with a note on the step.
    AddTrack: (edit) =>
      doc.transact(() => {
        const [id, pattern] = [nextId('t'), nextId('p')]
        doc.getMap('tracks').set(id, trackOf(hashes[edit.sound], edit.order, edit.synth))
        doc.getMap('clips').set(nextId('k'), clipOf(id, pattern, 0))
        notesOf(doc, pattern).set(nextId('n'), noteOf(edit.step))
      }),
    DeleteTrack: (edit) =>
      Option.map(track(edit.track), (id) =>
        Boolean.match(edit.remove, {
          onTrue: () => gone(doc.getMap('tracks'), id, true),
          onFalse: () => deleteTrack(doc, by, id)
        })
      ),
    // As an undo of the deletion writes it.
    RestoreTrack: (edit) =>
      Option.map(picked(deletedTracks(doc), edit.track), (id) =>
        doc.transact(() => mapIn(doc.getMap('tracks'), id).set('deleted', false))
      ),
    SetSound: (edit) =>
      Option.map(track(edit.track), (id) =>
        doc.transact(() => mapIn(doc.getMap('tracks'), id, 'instrument', 'samples').set('sample', hashes[edit.sound]))
      ),
    AddSlot: (edit) => doc.transact(() => slots(doc).set(nextId('s'), slotOf(edit.order, edit.position))),
    DeleteSlot: (edit) => Option.map(slot(edit.slot), (id) => gone(slots(doc), id, edit.remove)),
    MoveSlot: (edit) =>
      Option.map(slot(edit.slot), (id) => doc.transact(() => mapIn(slots(doc), id).set('order', ordered(edit.order)))),
    PutClip: (edit) =>
      Option.map(Option.all([pattern(edit.pattern), track(edit.track)]), ([id, on]) =>
        doc.transact(() => doc.getMap('clips').set(nextId('k'), clipOf(on, id, edit.step)))
      ),
    MoveClip: (edit) =>
      Option.map(Option.all([clip(edit.clip), track(edit.track)]), ([id, to]) =>
        doc.transact(() => {
          mapIn(doc.getMap('clips'), id).set('track', to)
          mapIn(doc.getMap('clips'), id).set('bounds', { tick: edit.step * stepTicks })
        })
      ),
    ResizeClip: (edit) => Option.map(clip(edit.clip), (id) => resizeClip(doc, by, id, edit.steps * stepTicks)),
    TrimClip: (edit) =>
      Option.map(clip(edit.clip), (id) =>
        trimClip(doc, by, id, {
          tick: Tick(edit.step * stepTicks),
          length: edit.steps * stepTicks,
          offset: edit.offset * stepTicks
        })
      ),
    DeleteClip: (edit) => Option.map(clip(edit.clip), (id) => gone(doc.getMap('clips'), id, edit.remove)),
    SetMute: (edit) => Option.map(track(edit.track), (id) => setMute(doc, by, id, edit.mute)),
    ToggleSolo: (edit) => Option.map(track(edit.track), local.solo),
    SetInsert: (edit) =>
      Option.map(Option.all([track(edit.track), insertOfNumber(edit.insert)]), ([id, into]) =>
        setTrackInsert(doc, by, id, into)
      ),
    SetInsertStrip: (edit) =>
      Option.map(insertOfNumber(edit.insert), (id) =>
        setInsertStrip(doc, by, id, strip[edit.param].id, paramValue(strip[edit.param], edit.position / 10))
      ),
    SetInsertMute: (edit) => Option.map(insertOfNumber(edit.insert), (id) => setInsertMute(doc, by, id, edit.mute)),
    HoldInsert: (edit) =>
      Option.map(track(edit.track), (id) => local.hold(HoldTarget.TrackInsert({ track: id }), edit.insert)),
    HoldInsertStrip: (edit) =>
      Option.map(insertOfNumber(edit.insert), (id) =>
        local.hold(
          HoldTarget.InsertStrip({ insert: id, param: strip[edit.param].id }),
          paramValue(strip[edit.param], edit.position / 10)
        )
      ),
    HoldShape: (edit) =>
      Option.map(track(edit.track), (id) =>
        local.hold(HoldTarget.TrackParam({ track: id, param: synthShapes[edit.oscillator].id }), edit.shape)
      ),
    HoldSynthKnob: (edit) =>
      Option.map(track(edit.track), (id) =>
        local.hold(
          HoldTarget.TrackParam({ track: id, param: synthKnobs[edit.knob].id }),
          paramValue(synthKnobs[edit.knob], edit.position / 10)
        )
      ),
    HoldStrip: (edit) =>
      Option.map(track(edit.track), (id) =>
        local.hold(
          HoldTarget.TrackStrip({ track: id, param: strip[edit.param].id }),
          paramValue(strip[edit.param], edit.position / 10)
        )
      ),
    HoldCutoff: (edit) =>
      Option.map(slot(edit.slot), (id) =>
        local.hold(HoldTarget.SlotParam({ slot: id, param: 'cutoff' }), paramValue(cutoff, edit.position / 10))
      ),
    HoldTempo: (edit) => local.hold(HoldTarget.Tempo(), 120 + edit.tempo * 12),
    LetGo: (edit) => local.letGo(edit.hold),
    Sleep: (edit) => local.sleep(edit.edits)
  })
}

// Longer than the engine's fades, a sound's length and the filter's tail.
const quietBlocks = 40

/** A bar of the arrangement from its start, at the project's tempo, between two quiet stretches; `play` plays it. */
const played = (engine: TestEngine, bpm: number, play: (playing: boolean) => void) => {
  blocks(engine, quietBlocks)
  const loopFrames = (barTicks * sampleRate * 60) / (bpm * ticksPerQuarter)
  play(true)
  const heard = blocks(engine, Math.ceil(loopFrames / 128))
  play(false)
  blocks(engine, quietBlocks)
  return heard
}

/** The order the insert sums tracks in differs, and so do the last bits of the sum. */
const tolerance = 1e-6

const sameSound = (a: Float32Array, b: Float32Array) =>
  a.length === b.length && a.every((sample, i) => Math.abs(sample - b[i]) <= tolerance)

interface Run {
  /** Edits the engine sleeps through first, as the page's does until its first Play. */
  readonly asleep: number
  readonly edits: ReadonlyArray<DocumentEdit>
}

/**
 * The project edited a step at a time, and then rebuilt from nothing: both sound the same, the rebuild needs no sound
 * stored or evicted, and the engine refuses nothing.
 */
const stepsAsFromNothing = ({ asleep, edits }: Run) =>
  Effect.gen(function* () {
    const registry = yield* AtomRegistry.AtomRegistry
    const engine = startEngine({ initial: {} })
    const sounds = yield* pageSounds(engine)
    const project = newDocument()
    const atoms = yield* followProject(project.doc)
    const listening = batchedState<Listening>(newListening)
    const holds = batchedState<Holds>(noHolds)
    const playing = batchedState(false)
    const play = (value: boolean) => registry.set(playing, value)
    const running = Atom.make(true)
    /** Edits the engine sleeps through yet. */
    const sleeping = { edits: 0 }
    const sleepFor = (edits: number) => {
      sleeping.edits = edits
      registry.set(running, edits === 0)
    }
    sleepFor(asleep)
    const asked = { stores: 0, evicts: 0 }
    const compiler = yield* compile(
      atoms,
      { listening, holds, playing, auditions: Atom.make<Auditions>(noAuditions) },
      {
        send: engine.send,
        storeSample: (hash, load) => {
          asked.stores += 1
          return sounds.store(hash, load)
        },
        evictSample: (hash) => {
          asked.evicts += 1
          return sounds.evict(hash)
        },
        running
      },
      library
    )
    const local: Local = {
      solo: (track) => registry.update(listening, (state) => toggledSolo(state, track)),
      hold: (target, value) => registry.update(holds, (held) => holding(held, target, value)),
      letGo: (n) =>
        registry.update(holds, (held) =>
          Option.match(picked(held, n), { onNone: () => held, onSome: ({ target }) => lettingGo(held, target) })
        ),
      sleep: sleepFor
    }
    yield* Effect.forEach(
      edits,
      (edit) =>
        Effect.gen(function* () {
          yield* sounds.settled
          // A paused context renders nothing.
          yield* Effect.when(
            Effect.sync(() => blocks(engine, 1)),
            Effect.sync(() => registry.get(running))
          )
          yield* Match.value(edit).pipe(
            Match.tag('Rebuild', () => Effect.asVoid(compiler.rebuild)),
            Match.orElse((edit) => Effect.sync(() => applied(project, local, edit)))
          )
          yield* Effect.when(
            Effect.sync(() => sleepFor(sleeping.edits - 1)),
            Effect.sync(() => edit._tag !== 'Sleep' && sleeping.edits > 0)
          )
        }),
      { discard: true }
    )
    // As Play wakes it.
    sleepFor(0)
    yield* sounds.settled
    // The tempo the engine plays: one held over the document's.
    const bpm = Option.getOrElse(
      heldValue(registry.get(holds), HoldTarget.Tempo()),
      () => readProject(project.doc).value.tempo
    )
    const stepByStep = played(engine, bpm, play)
    const before = { ...asked }
    const rebuilt = yield* compiler.rebuild
    yield* sounds.settled
    // A bug building step by step, which the rebuild would hide, fails here.
    yield* compiler.stored
    const fromNothing = played(engine, bpm, play)
    return (
      rebuilt &&
      asked.stores === before.stores &&
      asked.evicts === before.evicts &&
      engine.readEvents().length === 0 &&
      sameSound(stepByStep, fromNothing)
    )
  }).pipe(Effect.scoped, Effect.provideService(AtomRegistry.AtomRegistry, AtomRegistry.make()))

/** Few in `pnpm test`, many in `pnpm test:property`. */
const runs = Effect.runSync(
  Config.schema(Schema.Int.check(Schema.isGreaterThan(0)), 'PROPERTY_RUNS').pipe(Config.withDefault(50))
)

/** Candidates a failure is shrunk through, each a run more. */
const maxShrinks = 100

/** Far more than a run takes (~40 ms), for a loaded machine. */
const msPerRun = 500

const timeout = (runs + maxShrinks) * msPerRun

it.effect.prop(
  'a project built a step at a time sounds as one built from nothing',
  { asleep: asleepFirst, edits: Arbitrary.array(Arbitrary.schema(DocumentEdit), { maxLength: 30 }) },
  stepsAsFromNothing,
  { timeout, arbitrary: { runs, size: 40, maxShrinks } }
)
