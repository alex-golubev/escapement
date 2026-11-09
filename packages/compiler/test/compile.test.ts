import {
  Command,
  createInsert,
  createNode,
  DeviceEdit,
  LoopTicks,
  NodeHandle,
  PageNote,
  PatternHandle,
  type Send,
  setParam,
  setStripParam,
  type Transaction
} from '@escapement/engine'
import {
  defaultStrip,
  lastTick,
  MidiKey,
  plugins,
  Sha256,
  type StripValues,
  strip,
  Tick
} from '@escapement/engine-description'
import {
  addClip,
  addNote,
  addTrack,
  type Auditions,
  barTicks,
  batchedState,
  createProject,
  defaultTrackStrip,
  deleteTrack,
  eraseClips,
  followProject,
  HoldTarget,
  type Holds,
  holding,
  Id,
  lettingGo,
  moveClip,
  newListening,
  newWriter,
  noAuditions,
  noHolds,
  readProject,
  resizeClip,
  setMasterParam,
  setMasterStrip,
  setMute,
  setTempo,
  setTrackParam,
  setTrackStrip,
  stepTicks,
  toggledSolo,
  trimClip
} from '@escapement/model'
import { Array, Boolean, Deferred, Effect, Exit, Fiber, Option, Order } from 'effect'
import { Atom, AtomRegistry } from 'effect/reactivity'
import { describe, expect, it } from '@effect/vitest'
import * as Y from 'yjs'
import { type Compiler, compile, type SoundStatus } from '../src'

const by = newWriter('test')

const sounds = ['Kick', 'Snare'].map((name, i) => ({ name, sound: Sha256(`${i}b`.repeat(32)) }))
const [kick, snare] = sounds.map(({ sound }) => sound)
const other = Sha256('cd'.repeat(32))

const volumeTop = Option.getOrThrow(Option.fromUndefinedOr(strip.find(({ id }) => id === 'volume'))).max

/**
 * The handle a cell's first node gets: nodes are made tracks first, each its instrument then its fader, then the
 * master: its sum, slots and fader.
 */
const cell = (n: number) => NodeHandle(n)
const [kickNode, kickFader, snareNode, snareFader, master, filter, masterFader] = [1, 2, 3, 4, 5, 6, 7].map(cell)

/** The handle the pattern of the kick's clip gets, the first one a clip plays. */
const firstPattern = PatternHandle(1)

/** The kick's clip alone, from the start, for a bar or `length`. */
const alone = (pattern: PatternHandle, length = barTicks) =>
  DeviceEdit.SetClips({ clips: [{ tick: Tick(0), length, period: length, offset: 0, pattern }] })

/** A track's sampler: its strip is the engine's, as the track's volume and pan are its fader's. */
const sampler = (node: NodeHandle, sound: Sha256) =>
  createNode(plugins.sampler, node, {}, { sample: sound }, defaultStrip)

/** A track's fader, metered, with its strip: as a new track has it, unless given. */
const trackFader = (node: NodeHandle, strip: StripValues = defaultTrackStrip) => createInsert(node, strip, true)

/** A new track's strip with its volume at `volume`. */
const turnedTo = (volume: number): StripValues => ({ ...defaultTrackStrip, volume })

const transport = (playing: boolean, loopTicks = barTicks) =>
  Command.SetTransport({ playing, loopTicks: LoopTicks(loopTicks) })

/** A note a step long on the step given, middle C unless another key is. */
const step = (n: number, key = 60) => ({ tick: Tick(n * stepTicks), key: MidiKey(key), length: stepTicks })

/** As the engine gets a note a step long at full strength on the node. */
const played = (node: NodeHandle, n: number, key = 60) => ({
  tick: Tick(n * stepTicks),
  node,
  key: MidiKey(key),
  velocity: 1,
  length: stepTicks
})

interface Run {
  readonly doc: Y.Doc
  /** The kick's and the snare's, each a sampler. */
  readonly tracks: ReadonlyArray<Id>
  /** The kick's, from the start: the only clip of a new run. */
  readonly clip: Id
  /** The kick clip's. */
  readonly pattern: Id
  readonly slot: Id
  readonly compiler: Compiler
  /** Each transaction sent, the refused ones too. */
  readonly sent: Array<Transaction>
  readonly stored: Array<Sha256>
  readonly evicted: Array<Sha256>
  readonly shown: Array<readonly [Sha256, SoundStatus['_tag']]>
  /** The engine finds no room for the next one. */
  readonly refuseNext: () => void
  /** From now on a send throws, as a bug in the ring or the protocol would. */
  readonly breakSending: () => void
  /** Into solo or out of it, in this client's listening. */
  readonly solo: (track: Id) => void
  /** The engine runs, or stops taking what is in the ring. */
  readonly setRunning: (running: boolean) => void
  /** This client turns a control to the value, or lets it go. */
  readonly hold: (target: HoldTarget, value?: number) => void
  /** This client plays the arrangement, or stops it. */
  readonly play: (playing: boolean) => void
  /** This client plays these notes by hand now. */
  readonly audition: (auditions: Auditions) => void
}

/** Once every store and show started so far has run: they run apart from the compiler. */
const settled = ({ compiler }: Run) => Effect.orDie(compiler.stored)

/** How the effect ended, if it ends at once; one still waiting is none. */
const endedNow = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.map(Effect.forkChild(effect, { startImmediately: true }), (fiber) =>
    Option.fromUndefinedOr(fiber.pollUnsafe())
  )

/** The filter on the master, at its defaults, as no operation puts an effect anywhere yet. */
const putFilterOnMaster = (doc: Y.Doc) =>
  doc.transact(() => {
    const slot = new Y.Map<unknown>(
      Object.entries({
        plugin: { id: plugins.filter.id, version: plugins.filter.version },
        params: new Y.Map(),
        order: 'a0',
        deleted: false
      })
    )
    doc.getMap('master').set('slots', new Y.Map<unknown>([['filter', slot]]))
  })

/**
 * Compiles a project of the two sounds, each on a track, the kick's with a clip from the start, and the filter on the
 * master, while `use` runs, into an engine that keeps what it was sent. Each sound is in once `storing` ends.
 */
const compiled = (
  use: (run: Run) => Effect.Effect<void>,
  {
    running: runsFirst = true,
    playing: playsFirst = false,
    storing = Effect.void,
    broken = false
  }: { running?: boolean; playing?: boolean; storing?: Effect.Effect<void>; broken?: boolean } = {}
) => {
  const doc = new Y.Doc()
  createProject(doc, by)
  const tracks = sounds.map(({ sound }) =>
    Option.getOrThrow(addTrack(doc, by, { plugin: plugins.sampler, sounds: { sample: sound } }))
  )
  const clip = Option.getOrThrow(addClip(doc, by, { track: tracks[0], tick: Tick(0) }))
  putFilterOnMaster(doc)
  const { clips, master } = readProject(doc).value
  const sent: Array<Transaction> = []
  const stored: Array<Sha256> = []
  const evicted: Array<Sha256> = []
  const shown: Array<readonly [Sha256, SoundStatus['_tag']]> = []
  const room = { refuse: false }
  const keep: Send = (transaction) => {
    sent.push(transaction)
    const taken = !room.refuse
    room.refuse = false
    return taken
  }
  const throwing: Send = () => {
    throw new Error('The ring took a message it should not have')
  }
  const sending = { send: Boolean.match(broken, { onTrue: () => throwing, onFalse: () => keep }) }
  const send: Send = (transaction) => sending.send(transaction)
  const listening = batchedState(newListening)
  const running = Atom.make(runsFirst)
  const holds = batchedState<Holds>(noHolds)
  const playing = batchedState(playsFirst)
  const auditions = batchedState<Auditions>(noAuditions)
  const program = Effect.gen(function* () {
    const registry = yield* AtomRegistry.AtomRegistry
    const atoms = yield* followProject(doc)
    const compiler = yield* compile(
      atoms,
      { listening, holds, playing, auditions },
      {
        send,
        storeSample: (hash) => storing.pipe(Effect.andThen(Effect.sync(() => void stored.push(hash)))),
        evictSample: (hash) => {
          evicted.push(hash)
          return true
        },
        running
      },
      {
        load: (hash) =>
          Option.liftPredicate(hash, (hash) => hash !== other).pipe(
            Option.map(() => Effect.succeed({ sampleRate: 48_000, channels: [] }))
          ),
        show: (hash, status) => Effect.sync(() => void shown.push([hash, status._tag]))
      }
    )
    yield* use({
      doc,
      tracks,
      clip,
      pattern: clips[0].pattern,
      slot: master.slots[0].id,
      compiler,
      sent,
      stored,
      evicted,
      shown,
      refuseNext: () => {
        room.refuse = true
      },
      breakSending: () => {
        sending.send = throwing
      },
      solo: (track) => registry.update(listening, (state) => toggledSolo(state, track)),
      setRunning: (value) => registry.set(running, value),
      hold: (target, value) =>
        registry.update(holds, (held) =>
          Option.match(Option.fromUndefinedOr(value), {
            onNone: () => lettingGo(held, target),
            onSome: (value) => holding(held, target, value)
          })
        ),
      play: (value) => registry.set(playing, value),
      audition: (value) => registry.set(auditions, value)
    })
  })
  return program.pipe(Effect.scoped, Effect.provideService(AtomRegistry.AtomRegistry, AtomRegistry.make()))
}

/** The clips of a `SetClips` in the order of their ticks, then their patterns: the arrangement has them by ID. */
const clipsIn = (edit: DeviceEdit | undefined) =>
  Option.match(Option.filter(Option.fromUndefinedOr(edit), DeviceEdit.$is('SetClips')), {
    onNone: () => [],
    onSome: ({ clips }) => Array.sortWith(clips, ({ tick, pattern }) => tick * 2 ** 32 + pattern, Order.Number)
  })

/** Each transaction sent after the first, which builds everything. */
const changes = (run: Run, act: () => void) => {
  const from = run.sent.length
  act()
  return run.sent.slice(from)
}

/** Whether a rebuild found room, and each transaction it sent. */
const rebuilding = (run: Run) =>
  Effect.gen(function* () {
    const from = run.sent.length
    const taken = yield* run.compiler.rebuild
    return { taken, sent: run.sent.slice(from) }
  })

const setSound = (doc: Y.Doc, track: Id, sound: Sha256) =>
  doc.transact(() => {
    const instrument = Option.getOrThrowWith(
      Option.liftPredicate(doc.getMap('tracks').get(track), (instrument) => instrument instanceof Y.Map),
      () => new Error('No track')
    )
    const samples = (instrument.get('instrument') as Y.Map<Y.Map<unknown>>).get('samples')
    samples?.set('sample', sound)
  })

const slotMap = (doc: Y.Doc) => doc.getMap('master').get('slots') as Y.Map<Y.Map<unknown>>

const addSlot = (doc: Y.Doc, id: string, order: string, cutoff = 1000) =>
  doc.transact(() =>
    slotMap(doc).set(
      id,
      new Y.Map<unknown>(
        Object.entries({
          plugin: { id: plugins.filter.id, version: plugins.filter.version },
          params: new Y.Map(Object.entries({ cutoff })),
          order,
          deleted: false
        })
      )
    )
  )

describe('the compiler', () => {
  it.effect('tells once the sounds it asked for are in', () => {
    const loaded = Deferred.makeUnsafe<void>()
    return compiled(
      (run) =>
        Effect.gen(function* () {
          const stored = yield* Effect.forkChild(Effect.orDie(run.compiler.stored), { startImmediately: true })
          yield* Effect.yieldNow
          expect(stored.pollUnsafe()).toBeUndefined()
          yield* Deferred.succeed(loaded, undefined)
          yield* Fiber.join(stored)
          expect(run.shown).toEqual([
            [kick, 'Stored'],
            [snare, 'Stored']
          ])
        }),
      { storing: Deferred.await(loaded) }
    )
  })

  it.effect('builds everything while the engine sleeps, holds what comes after, and sends it as one once it runs', () =>
    compiled(
      (run) =>
        Effect.gen(function* () {
          const { doc, tracks, clip } = run
          expect(run.sent).toHaveLength(1)
          addNote(doc, by, clip, step(0))
          setTrackStrip(doc, by, tracks[1], 'volume', 0.3)
          setSound(doc, tracks[1], other)
          expect(run.sent).toHaveLength(1)
          yield* settled(run)
          expect(run.stored).toEqual([kick, snare])
          expect(run.evicted).toEqual([snare])
          const snareAgain = NodeHandle((1 << 16) | 3)
          expect(changes(run, () => run.setRunning(true))).toEqual([
            {
              edits: [
                DeviceEdit.DestroyNode({ node: snareNode }),
                sampler(snareAgain, other),
                DeviceEdit.Connect({ from: snareAgain, to: snareFader }),
                DeviceEdit.SetPattern({
                  pattern: firstPattern,
                  notes: [{ tick: Tick(0), node: kickNode, key: MidiKey(60), velocity: 1, length: stepTicks }]
                })
              ],
              commands: [setStripParam(snareFader, 'volume', 0.3)]
            }
          ])
          expect(changes(run, () => setTempo(doc, by, 90))).toEqual([
            { edits: [], commands: [Command.SetTempo({ bpm: 90 })] }
          ])
        }),
      { running: false }
    )
  )

  it.effect(
    'plays a held value over the document, sends nothing for the document meanwhile, and nothing more on letting go',
    () =>
      compiled((run) =>
        Effect.sync(() => {
          const { doc, slot } = run
          // A synth, as + adds it, in the next cell, its fader after it: a sampler has no parameter of its own.
          const synth = Option.getOrThrow(addTrack(doc, by))
          const synthNode = cell(8)
          const shape = HoldTarget.TrackParam({ track: synth, param: 'osc1.shape' })
          expect(changes(run, () => run.hold(shape, 1))).toEqual([
            { edits: [], commands: [setParam(plugins.synth, synthNode, 'osc1.shape', 1)] }
          ])
          expect(changes(run, () => setTrackParam(doc, by, synth, 'osc1.shape', 0))).toEqual([])
          expect(changes(run, () => run.hold(shape, 2))).toEqual([
            { edits: [], commands: [setParam(plugins.synth, synthNode, 'osc1.shape', 2)] }
          ])
          setTrackParam(doc, by, synth, 'osc1.shape', 2)
          expect(changes(run, () => run.hold(shape))).toEqual([])

          const cutoff = HoldTarget.SlotParam({ slot, param: 'cutoff' })
          expect(changes(run, () => run.hold(cutoff, 500))).toEqual([
            { edits: [], commands: [setParam(plugins.filter, filter, 'cutoff', 500)] }
          ])
          // Let go before the document has it: the document's value plays again.
          expect(changes(run, () => run.hold(cutoff))).toEqual([
            { edits: [], commands: [setParam(plugins.filter, filter, 'cutoff', 20000)] }
          ])

          expect(changes(run, () => run.hold(HoldTarget.Tempo(), 140))).toEqual([
            { edits: [], commands: [Command.SetTempo({ bpm: 140 })] }
          ])
          expect(changes(run, () => setTempo(doc, by, 130))).toEqual([])
          expect(changes(run, () => run.hold(HoldTarget.Tempo()))).toEqual([
            { edits: [], commands: [Command.SetTempo({ bpm: 130 })] }
          ])

          // A held value plays as the document's would read: in range, a choice the nearest, and a number.
          expect(changes(run, () => run.hold(shape, 5))).toEqual([
            { edits: [], commands: [setParam(plugins.synth, synthNode, 'osc1.shape', 4)] }
          ])
          expect(changes(run, () => run.hold(shape, 0.6))).toEqual([
            { edits: [], commands: [setParam(plugins.synth, synthNode, 'osc1.shape', 1)] }
          ])
          expect(changes(run, () => run.hold(shape, Number.NaN))).toEqual([
            { edits: [], commands: [setParam(plugins.synth, synthNode, 'osc1.shape', 2)] }
          ])
          run.hold(shape)
          expect(changes(run, () => run.hold(HoldTarget.Tempo(), 9999))).toEqual([
            { edits: [], commands: [Command.SetTempo({ bpm: 522 })] }
          ])
          run.hold(HoldTarget.Tempo())
          expect(changes(run, () => run.hold(HoldTarget.Tempo(), Number.NaN))).toEqual([])
          run.hold(HoldTarget.Tempo())

          // A held parameter the instrument doesn't have plays nothing: the synth has no cutoff, the sampler no shape.
          expect(changes(run, () => run.hold(HoldTarget.TrackParam({ track: synth, param: 'cutoff' }), 500))).toEqual(
            []
          )
          expect(
            changes(run, () => run.hold(HoldTarget.TrackParam({ track: run.tracks[0], param: 'osc1.shape' }), 1))
          ).toEqual([])
        })
      )
  )

  it.effect(
    "plays a track's strip on its fader, a held value over the document's, kept as its instrument is made anew",
    () =>
      compiled((run) =>
        Effect.sync(() => {
          const { doc, tracks } = run
          expect(changes(run, () => setTrackStrip(doc, by, tracks[0], 'pan', -0.5))).toEqual([
            { edits: [], commands: [setStripParam(kickFader, 'pan', -0.5)] }
          ])
          const volume = HoldTarget.TrackStrip({ track: tracks[0], param: 'volume' })
          expect(changes(run, () => run.hold(volume, 0.3))).toEqual([
            { edits: [], commands: [setStripParam(kickFader, 'volume', 0.3)] }
          ])
          expect(changes(run, () => setTrackStrip(doc, by, tracks[0], 'volume', 0.25))).toEqual([])
          // As the document's would read: in range, and a number.
          expect(changes(run, () => run.hold(volume, 5))).toEqual([
            { edits: [], commands: [setStripParam(kickFader, 'volume', volumeTop)] }
          ])
          expect(changes(run, () => run.hold(volume, Number.NaN))).toEqual([
            { edits: [], commands: [setStripParam(kickFader, 'volume', 0.25)] }
          ])
          expect(changes(run, () => run.hold(volume))).toEqual([])
          const kickAgain = NodeHandle((1 << 16) | 1)
          expect(changes(run, () => setSound(doc, tracks[0], other))).toEqual([
            {
              edits: [
                DeviceEdit.DestroyNode({ node: kickNode }),
                sampler(kickAgain, other),
                DeviceEdit.Connect({ from: kickAgain, to: kickFader })
              ],
              commands: []
            }
          ])
        })
      )
  )

  it.effect("plays the master's strip on its fader, after its slots, a held value over the document's", () =>
    compiled((run) =>
      Effect.sync(() => {
        const { doc } = run
        expect(changes(run, () => setMasterStrip(doc, by, 'pan', -0.5))).toEqual([
          { edits: [], commands: [setStripParam(masterFader, 'pan', -0.5)] }
        ])
        const fader = HoldTarget.MasterStrip({ param: 'volume' })
        expect(changes(run, () => run.hold(fader, 0.25))).toEqual([
          { edits: [], commands: [setStripParam(masterFader, 'volume', 0.25)] }
        ])
        expect(changes(run, () => run.hold(fader, 9))).toEqual([
          { edits: [], commands: [setStripParam(masterFader, 'volume', volumeTop)] }
        ])
        expect(changes(run, () => run.hold(fader))).toEqual([
          { edits: [], commands: [setStripParam(masterFader, 'volume', 1)] }
        ])
      })
    )
  )

  it.effect('holds the changes again once the engine stops running, and a rebuild with them', () =>
    compiled((run) =>
      Effect.gen(function* () {
        const { doc, tracks } = run
        run.setRunning(false)
        setTrackStrip(doc, by, tracks[0], 'volume', 0.1)
        setTrackStrip(doc, by, tracks[0], 'volume', 0.2)
        expect(yield* rebuilding(run)).toEqual({ taken: true, sent: [] })
        const [rebuilt] = changes(run, () => run.setRunning(true))
        expect(rebuilt.edits?.[0]).toEqual(DeviceEdit.Reset({ epoch: 1 }))
        expect(rebuilt.edits).toContainEqual(trackFader(NodeHandle((1 << 16) | 2), turnedTo(0.2)))
        expect(changes(run, () => run.setRunning(true))).toEqual([])
      })
    )
  )

  it.effect('first builds everything the project has, in one transaction, and stores its sounds', () =>
    compiled((run) =>
      Effect.gen(function* () {
        const { sent, stored, shown } = run
        expect(sent).toEqual([
          {
            edits: [
              sampler(kickNode, kick),
              trackFader(kickFader),
              sampler(snareNode, snare),
              trackFader(snareFader),
              createInsert(master),
              createNode(plugins.filter, filter, { cutoff: 20000 }),
              createInsert(masterFader),
              DeviceEdit.Connect({ from: kickNode, to: kickFader }),
              DeviceEdit.Connect({ from: snareNode, to: snareFader }),
              DeviceEdit.Connect({ from: kickFader, to: master }),
              DeviceEdit.Connect({ from: snareFader, to: master }),
              DeviceEdit.Connect({ from: master, to: filter }),
              DeviceEdit.Connect({ from: filter, to: masterFader }),
              DeviceEdit.SetOutput({ node: masterFader }),
              DeviceEdit.SetPattern({ pattern: firstPattern, notes: [] }),
              alone(firstPattern)
            ],
            commands: [Command.SetTempo({ bpm: 120 }), transport(false)]
          }
        ])
        yield* settled(run)
        expect(stored).toEqual([kick, snare])
        expect(shown).toEqual([
          [kick, 'Stored'],
          [snare, 'Stored']
        ])
      })
    )
  )

  it.effect('plays and stops as this client asks, held while the engine sleeps, and a rebuild plays on', () =>
    compiled((run) =>
      Effect.gen(function* () {
        expect(changes(run, () => run.play(true))).toEqual([{ edits: [], commands: [transport(true)] }])
        const {
          taken,
          sent: [rebuilt]
        } = yield* rebuilding(run)
        expect(taken).toBe(true)
        expect(rebuilt.commands).toEqual([Command.SetTempo({ bpm: 120 }), transport(true)])
        expect(changes(run, () => run.play(false))).toEqual([{ edits: [], commands: [transport(false)] }])
        run.setRunning(false)
        expect(changes(run, () => run.play(true))).toEqual([])
        expect(changes(run, () => run.setRunning(true))).toEqual([{ edits: [], commands: [transport(true)] }])
      })
    )
  )

  it.effect('builds a new engine playing when this client plays', () =>
    compiled(
      ({ sent }) =>
        Effect.sync(() => {
          expect(sent[0].commands).toEqual([Command.SetTempo({ bpm: 120 }), transport(true)])
        }),
      { playing: true }
    )
  )

  it.effect('sends a knob and the tempo as they play, and the pattern whole', () =>
    compiled((run) =>
      Effect.sync(() => {
        const { doc, tracks, clip, slot } = run
        expect(changes(run, () => setTrackStrip(doc, by, tracks[1], 'volume', 0.3))).toEqual([
          { edits: [], commands: [setStripParam(snareFader, 'volume', 0.3)] }
        ])
        expect(changes(run, () => setMasterParam(doc, by, slot, 'cutoff', 500))).toEqual([
          { edits: [], commands: [setParam(plugins.filter, filter, 'cutoff', 500)] }
        ])
        expect(changes(run, () => setTempo(doc, by, 90))).toEqual([
          { edits: [], commands: [Command.SetTempo({ bpm: 90 })] }
        ])
        addNote(doc, by, clip, step(0))
        const [change] = changes(run, () => addNote(doc, by, clip, step(2)))
        const [edit] = change.edits ?? []
        expect(change.commands).toEqual([])
        expect(edit?._tag === 'SetPattern' && edit.notes.toSorted((a, b) => a.tick - b.tick)).toEqual([
          played(kickNode, 0),
          played(kickNode, 2)
        ])
      })
    )
  )

  it.effect('makes a track anew in a fresh cell when its sound changes, and swaps the sounds', () =>
    compiled((run) =>
      Effect.gen(function* () {
        const { doc, tracks, clip } = run
        addNote(doc, by, clip, step(0))
        setTrackStrip(doc, by, tracks[0], 'volume', 0.5)
        const kickAgain = NodeHandle((1 << 16) | 1)
        expect(changes(run, () => setSound(doc, tracks[0], snare))).toEqual([
          {
            edits: [
              DeviceEdit.DestroyNode({ node: kickNode }),
              sampler(kickAgain, snare),
              DeviceEdit.Connect({ from: kickAgain, to: kickFader }),
              DeviceEdit.SetPattern({
                pattern: firstPattern,
                notes: [{ tick: Tick(0), node: kickAgain, key: MidiKey(60), velocity: 1, length: stepTicks }]
              })
            ],
            commands: []
          }
        ])
        expect(run.evicted).toEqual([kick])
        setSound(doc, tracks[1], other)
        expect(run.evicted).toEqual([kick])
        setSound(doc, tracks[0], other)
        expect(run.evicted).toEqual([kick, snare])
        yield* settled(run)
        expect(run.shown.slice(2)).toEqual([
          [kick, 'Evicted'],
          [other, 'Missing'],
          [snare, 'Evicted']
        ])
      })
    )
  )

  it.effect('puts a slot in its place on the master, takes it out, and turns two round', () =>
    compiled((run) =>
      Effect.sync(() => {
        const { doc } = run
        const first = cell(8)
        expect(changes(run, () => addSlot(doc, 'first', ' '))).toEqual([
          {
            edits: [
              createNode(plugins.filter, first, { cutoff: 1000 }),
              DeviceEdit.Disconnect({ from: master, to: filter }),
              DeviceEdit.Connect({ from: master, to: first }),
              DeviceEdit.Connect({ from: first, to: filter })
            ],
            commands: []
          }
        ])
        expect(changes(run, () => doc.transact(() => slotMap(doc).get('first')?.set('order', '~')))).toEqual([
          {
            edits: [
              DeviceEdit.Disconnect({ from: master, to: first }),
              DeviceEdit.Disconnect({ from: first, to: filter }),
              DeviceEdit.Disconnect({ from: filter, to: masterFader }),
              DeviceEdit.Connect({ from: master, to: filter }),
              DeviceEdit.Connect({ from: filter, to: first }),
              DeviceEdit.Connect({ from: first, to: masterFader })
            ],
            commands: []
          }
        ])
        expect(changes(run, () => doc.transact(() => slotMap(doc).get('first')?.set('deleted', true)))).toEqual([
          {
            edits: [DeviceEdit.DestroyNode({ node: first }), DeviceEdit.Connect({ from: filter, to: masterFader })],
            commands: []
          }
        ])
        expect(changes(run, () => doc.transact(() => slotMap(doc).delete(run.slot)))).toEqual([
          {
            edits: [DeviceEdit.DestroyNode({ node: filter }), DeviceEdit.Connect({ from: master, to: masterFader })],
            commands: []
          }
        ])
      })
    )
  )

  it.effect('plays notes alike once, and none on a track that has no node', () =>
    compiled((run) =>
      Effect.sync(() => {
        const { doc, tracks, pattern } = run
        const note = (key: number) => ({ tick: 0, len: stepTicks, key, vel: 1 })
        const notes = doc.getMap(`notes/${pattern}`)
        doc.transact(() => {
          notes.set('b', note(60))
          notes.set('a', { ...note(60), vel: 0.5 })
          notes.set('c', note(62))
        })
        expect(run.sent.at(-1)?.edits).toEqual([
          DeviceEdit.SetPattern({
            pattern: firstPattern,
            notes: [
              { tick: Tick(0), node: kickNode, key: MidiKey(60), velocity: 0.5, length: stepTicks },
              { tick: Tick(0), node: kickNode, key: MidiKey(62), velocity: 1, length: stepTicks }
            ]
          })
        ])
        const track = doc.getMap('tracks').get(tracks[0]) as Y.Map<unknown>
        // Its fader goes with it: nothing would go into it.
        expect(changes(run, () => doc.transact(() => track.delete('instrument')))).toEqual([
          {
            edits: [
              DeviceEdit.DestroyNode({ node: kickNode }),
              DeviceEdit.DestroyNode({ node: kickFader }),
              DeviceEdit.SetPattern({ pattern: firstPattern, notes: [] })
            ],
            commands: []
          }
        ])
        expect(run.evicted).toEqual([kick])
      })
    )
  )

  it.effect(
    'loops to the end of the last bar a note sounds in, its clip as long; a note is as long as the wire carries',
    () =>
      compiled((run) =>
        Effect.sync(() => {
          const { doc, pattern, play } = run
          const notes = doc.getMap(`notes/${pattern}`)
          play(true)
          doc.transact(() => {
            notes.set('b', { tick: barTicks - 1, len: stepTicks, key: 62, vel: 1 })
            notes.set('c', { tick: barTicks, len: stepTicks, key: 64, vel: 1 })
          })
          expect(run.sent.at(-1)).toEqual({
            edits: [
              DeviceEdit.SetPattern({
                pattern: firstPattern,
                notes: [
                  { tick: Tick(barTicks - 1), node: kickNode, key: MidiKey(62), velocity: 1, length: stepTicks },
                  { tick: Tick(barTicks), node: kickNode, key: MidiKey(64), velocity: 1, length: stepTicks }
                ]
              }),
              alone(firstPattern, 2 * barTicks)
            ],
            commands: [transport(true, 2 * barTicks)]
          })
          // As long as the document lets a note at the start be, longer than the wire's 32 bits can carry.
          doc.transact(() => notes.set('a', { tick: 0, len: 2 ** 32, key: 60, vel: 1 }))
          const longest = Math.floor(lastTick / barTicks) * barTicks
          expect(run.sent.at(-1)?.commands).toEqual([transport(true, longest)])
          expect(run.sent.at(-1)?.edits?.at(0)).toMatchObject({
            notes: expect.arrayContaining([
              { tick: Tick(0), node: kickNode, key: MidiKey(60), velocity: 1, length: lastTick }
            ])
          })
          expect(run.sent.at(-1)?.edits?.at(1)).toEqual(alone(firstPattern, longest))
        })
      )
  )

  it.effect(
    "plays the arrangement: each clip's pattern on its track's node, sent once, and the loop to its last clip's bar",
    () =>
      compiled((run) =>
        Effect.sync(() => {
          const { doc, tracks, clip, play } = run
          play(true)
          addNote(doc, by, clip, step(0))
          const place = (track: Id, bar: number) => ({ track, tick: Tick(bar * barTicks) })
          // A clip of its own pattern: the pattern goes to a cell of its own, empty, and the clips with it.
          const other = PatternHandle(2)
          const kickClip = { tick: Tick(0), length: barTicks, period: barTicks, offset: 0, pattern: firstPattern }
          const [added] = changes(run, () => addClip(doc, by, place(tracks[1], 2)))
          const snare = Option.getOrThrow(
            Option.fromUndefinedOr(readProject(doc).value.clips.find(({ track }) => track === tracks[1]))
          )
          expect(added.edits?.at(0)).toEqual(DeviceEdit.SetPattern({ pattern: other, notes: [] }))
          expect(clipsIn(added.edits?.at(1))).toEqual([
            kickClip,
            { tick: Tick(2 * barTicks), length: barTicks, period: barTicks, offset: 0, pattern: other }
          ])
          expect(added.edits).toHaveLength(2)
          expect(added.commands).toEqual([transport(true, 3 * barTicks)])
          // A note of the second bar sends its pattern alone, on the snare, and the clips as long as it grew.
          const [noted] = changes(run, () => addNote(doc, by, snare.id, { ...step(0, 64), tick: Tick(barTicks) }))
          expect(noted.edits?.at(0)).toEqual(
            DeviceEdit.SetPattern({ pattern: other, notes: [{ ...played(snareNode, 0, 64), tick: Tick(barTicks) }] })
          )
          expect(clipsIn(noted.edits?.at(1)).at(-1)).toEqual({
            tick: Tick(2 * barTicks),
            length: 2 * barTicks,
            period: 2 * barTicks,
            offset: 0,
            pattern: other
          })
          expect(noted.commands).toEqual([transport(true, 4 * barTicks)])
          // A clip moved sends the clips alone, and the loop as the arrangement's end moves.
          const [moved] = changes(run, () => moveClip(doc, by, snare.id, place(tracks[1], 4)))
          expect(moved.edits).toHaveLength(1)
          expect(clipsIn(moved.edits?.at(0)).at(-1)).toMatchObject({ tick: Tick(4 * barTicks), pattern: other })
          expect(moved.commands).toEqual([transport(true, 6 * barTicks)])
          // A clip made longer than its pattern sends the clips alone, going round the pattern, and the loop to its end.
          const [longer] = changes(run, () => resizeClip(doc, by, snare.id, 5 * barTicks))
          expect(longer.edits).toHaveLength(1)
          expect(clipsIn(longer.edits?.at(0)).at(-1)).toEqual({
            tick: Tick(4 * barTicks),
            length: 5 * barTicks,
            period: 2 * barTicks,
            offset: 0,
            pattern: other
          })
          expect(longer.commands).toEqual([transport(true, 9 * barTicks)])
          // Trimmed at its start, from its pattern's second bar: the clips alone, the loop as it was.
          const trimmed = changes(run, () =>
            trimClip(doc, by, snare.id, { tick: Tick(5 * barTicks), length: 4 * barTicks, offset: barTicks })
          )
          expect(trimmed.map(({ edits }) => clipsIn(edits?.at(0)).at(-1))).toEqual([
            { tick: Tick(5 * barTicks), length: 4 * barTicks, period: 2 * barTicks, offset: barTicks, pattern: other }
          ])
          expect(trimmed.map(({ commands }) => commands)).toEqual([[]])
          // Erased, it takes its pattern with it.
          expect(changes(run, () => eraseClips(doc, by, [snare.id]))).toEqual([
            { edits: [DeviceEdit.DestroyPattern({ pattern: other }), alone(firstPattern)], commands: [transport(true)] }
          ])
        })
      )
  )

  it.effect(
    "plays a clip moved to another track on that track's node, and one pattern on two tracks as two in the engine",
    () =>
      compiled((run) =>
        Effect.sync(() => {
          const { doc, tracks, clip, pattern } = run
          addNote(doc, by, clip, step(0))
          const inCell = PatternHandle((1 << 16) | 1)
          // Another key in the engine: the pattern on the kick's goes, and the one on the snare's takes its cell.
          expect(changes(run, () => moveClip(doc, by, clip, { track: tracks[1], tick: Tick(0) }))).toEqual([
            {
              edits: [
                DeviceEdit.DestroyPattern({ pattern: firstPattern }),
                DeviceEdit.SetPattern({ pattern: inCell, notes: [played(snareNode, 0)] }),
                alone(inCell)
              ],
              commands: []
            }
          ])
          // A clip of the same pattern on the kick's, as a client of a later build may write it.
          const [both] = changes(run, () =>
            doc.transact(() =>
              doc
                .getMap('clips')
                .set(
                  'copy',
                  new Y.Map<unknown>(
                    Object.entries({ track: tracks[0], bounds: { tick: barTicks }, pattern, deleted: false })
                  )
                )
            )
          )
          const kickCell = PatternHandle(2)
          expect(both.edits?.at(0)).toEqual(DeviceEdit.SetPattern({ pattern: kickCell, notes: [played(kickNode, 0)] }))
          expect(clipsIn(both.edits?.at(1)).map(({ tick, pattern }) => [tick, pattern])).toEqual([
            [0, inCell],
            [barTicks, kickCell]
          ])
        })
      )
  )

  it.effect("makes a pattern keyed as an object's own names are, as another client may write it, as any other", () =>
    compiled((run) =>
      Effect.sync(() => {
        const { doc, tracks } = run
        const [added] = changes(run, () =>
          doc.transact(() => {
            doc
              .getMap('clips')
              .set(
                'toString',
                new Y.Map<unknown>(
                  Object.entries({ track: tracks[0], bounds: { tick: barTicks }, pattern: 'toString', deleted: false })
                )
              )
            doc.getMap('notes/toString').set('n', { tick: 0, len: stepTicks, key: 60, vel: 1 })
          })
        )
        expect(added.edits?.at(0)).toEqual(
          DeviceEdit.SetPattern({ pattern: PatternHandle(2), notes: [played(kickNode, 0)] })
        )
        expect(clipsIn(added.edits?.at(1))).toHaveLength(2)
      })
    )
  )

  it.effect('carries a change the engine found no room for in the next one, and follows the sounds meanwhile', () =>
    compiled((run) =>
      Effect.gen(function* () {
        const { doc, tracks } = run
        run.refuseNext()
        setTrackStrip(doc, by, tracks[0], 'volume', 0.1)
        expect(changes(run, () => setTrackStrip(doc, by, tracks[1], 'volume', 0.2))).toEqual([
          {
            edits: [],
            commands: [setStripParam(kickFader, 'volume', 0.1), setStripParam(snareFader, 'volume', 0.2)]
          }
        ])
        run.refuseNext()
        setSound(doc, tracks[0], other)
        expect(run.evicted).toEqual([kick])
        run.refuseNext()
        expect(yield* run.compiler.rebuild).toBe(false)
        const [rebuilt] = changes(run, () => setTempo(doc, by, 90))
        expect(rebuilt.edits?.[0]).toEqual(DeviceEdit.Reset({ epoch: 1 }))
        expect(rebuilt.commands).toEqual([Command.SetTempo({ bpm: 90 }), transport(false)])
      })
    )
  )

  it.effect('rebuilds from nothing in the next session, keeping the sounds', () =>
    compiled((run) =>
      Effect.gen(function* () {
        const { doc, clip } = run
        addNote(doc, by, clip, step(0))
        yield* settled(run)
        const next = (n: number) => NodeHandle((1 << 16) | n)
        expect(yield* rebuilding(run)).toEqual({
          taken: true,
          sent: [
            {
              edits: [
                DeviceEdit.Reset({ epoch: 1 }),
                sampler(next(1), kick),
                trackFader(next(2)),
                sampler(next(3), snare),
                trackFader(next(4)),
                createInsert(next(5)),
                createNode(plugins.filter, next(6), { cutoff: 20000 }),
                createInsert(next(7)),
                DeviceEdit.Connect({ from: next(1), to: next(2) }),
                DeviceEdit.Connect({ from: next(3), to: next(4) }),
                DeviceEdit.Connect({ from: next(2), to: next(5) }),
                DeviceEdit.Connect({ from: next(4), to: next(5) }),
                DeviceEdit.Connect({ from: next(5), to: next(6) }),
                DeviceEdit.Connect({ from: next(6), to: next(7) }),
                DeviceEdit.SetOutput({ node: next(7) }),
                DeviceEdit.SetPattern({
                  pattern: PatternHandle((1 << 16) | 1),
                  notes: [{ tick: Tick(0), node: next(1), key: MidiKey(60), velocity: 1, length: stepTicks }]
                }),
                alone(PatternHandle((1 << 16) | 1))
              ],
              commands: [Command.SetTempo({ bpm: 120 }), transport(false)]
            }
          ]
        })
        yield* settled(run)
        expect(run.stored).toEqual([kick, snare])
        expect(run.evicted).toEqual([])
        expect(changes(run, () => doc.transact(() => doc.getMap('meta').set('bpm', 120)))).toEqual([])
        expect(changes(run, () => setTempo(doc, by, 90))).toEqual([
          { edits: [], commands: [Command.SetTempo({ bpm: 90 })] }
        ])
      })
    )
  )
  it.effect('mutes a track: its notes leave the pattern, it is cut off, and it keeps its node and sound', () =>
    compiled((run) =>
      Effect.sync(() => {
        const { doc, tracks, clip } = run
        addNote(doc, by, clip, step(0))
        const kick = { tick: Tick(0), node: kickNode, key: MidiKey(60), velocity: 1, length: stepTicks }
        expect(changes(run, () => setMute(doc, by, tracks[0], true))).toEqual([
          {
            edits: [
              DeviceEdit.Disconnect({ from: kickNode, to: kickFader }),
              DeviceEdit.SetPattern({ pattern: firstPattern, notes: [] }),
              DeviceEdit.LetGoOfNotes({ node: kickNode })
            ],
            commands: []
          }
        ])
        expect(changes(run, () => setMute(doc, by, tracks[0], false))).toEqual([
          {
            edits: [
              DeviceEdit.Connect({ from: kickNode, to: kickFader }),
              DeviceEdit.SetPattern({ pattern: firstPattern, notes: [kick] })
            ],
            commands: []
          }
        ])
        // Left out of a solo, the same, and back once the solo ends.
        const out = {
          edits: [
            DeviceEdit.Disconnect({ from: kickNode, to: kickFader }),
            DeviceEdit.SetPattern({ pattern: firstPattern, notes: [] }),
            DeviceEdit.LetGoOfNotes({ node: kickNode })
          ],
          commands: []
        }
        const back = {
          edits: [
            DeviceEdit.Connect({ from: kickNode, to: kickFader }),
            DeviceEdit.SetPattern({ pattern: firstPattern, notes: [kick] })
          ],
          commands: []
        }
        expect(changes(run, () => run.solo(tracks[1]))).toEqual([out])
        expect(changes(run, () => run.solo(tracks[1]))).toEqual([back])
        // Muted in the document, a solo brings it back, leaving the others out, and its end mutes it again.
        expect(changes(run, () => setMute(doc, by, tracks[0], true))).toEqual([out])
        expect(changes(run, () => run.solo(tracks[0]))).toEqual([
          {
            edits: [
              DeviceEdit.Disconnect({ from: snareNode, to: snareFader }),
              DeviceEdit.Connect({ from: kickNode, to: kickFader }),
              DeviceEdit.SetPattern({ pattern: firstPattern, notes: [kick] }),
              DeviceEdit.LetGoOfNotes({ node: snareNode })
            ],
            commands: []
          }
        ])
        expect(changes(run, () => run.solo(tracks[0]))).toEqual([
          {
            edits: [
              DeviceEdit.Disconnect({ from: kickNode, to: kickFader }),
              DeviceEdit.Connect({ from: snareNode, to: snareFader }),
              DeviceEdit.SetPattern({ pattern: firstPattern, notes: [] }),
              DeviceEdit.LetGoOfNotes({ node: kickNode })
            ],
            commands: []
          }
        ])
        expect(run.evicted).toEqual([])
      })
    )
  )

  it.effect('solos tracks for this client only, muted in the document or not', () =>
    compiled((run) =>
      Effect.sync(() => {
        const { doc, tracks } = run
        const updates = { count: 0 }
        doc.on('update', () => {
          updates.count += 1
        })
        setMute(doc, by, tracks[1], true)
        expect(changes(run, () => run.solo(tracks[1]))).toEqual([
          {
            edits: [
              DeviceEdit.Disconnect({ from: kickNode, to: kickFader }),
              DeviceEdit.Connect({ from: snareNode, to: snareFader }),
              DeviceEdit.LetGoOfNotes({ node: kickNode })
            ],
            commands: []
          }
        ])
        expect(changes(run, () => run.solo(tracks[0]))).toEqual([
          { edits: [DeviceEdit.Connect({ from: kickNode, to: kickFader })], commands: [] }
        ])
        expect(changes(run, () => setMute(doc, by, tracks[0], true))).toEqual([])
        expect(changes(run, () => run.solo(tracks[1]))).toEqual([
          {
            edits: [
              DeviceEdit.Disconnect({ from: snareNode, to: snareFader }),
              DeviceEdit.LetGoOfNotes({ node: snareNode })
            ],
            commands: []
          }
        ])
        // The mute just now and the one before: solo wrote nothing.
        expect(updates.count).toBe(2)
      })
    )
  )

  it.effect(
    'plays notes by hand on a track heard while the arrangement stops, from press to release, again on a node made anew',
    () =>
      compiled((run) =>
        Effect.gen(function* () {
          const { doc, tracks } = run
          const c5 = { track: tracks[0], key: MidiKey(60), velocity: 1, press: 1 }
          const e5 = { track: tracks[1], key: MidiKey(64), velocity: 0.5, press: 2 }
          const on = (node: NodeHandle, { key, velocity, press }: typeof c5) =>
            Command.NoteOn({ node, key, velocity, note: PageNote(press) })
          const off = (node: NodeHandle, { press }: typeof c5) => Command.NoteOff({ node, note: PageNote(press) })
          const only = (...commands: ReadonlyArray<Command>) => [{ edits: [], commands }]
          // Pressed and let go of while the engine sleeps: nothing as it wakes; one held, pressed as it wakes.
          run.setRunning(false)
          expect(changes(run, () => run.audition([c5]))).toEqual([])
          expect(changes(run, () => run.audition([]))).toEqual([])
          expect(changes(run, () => run.setRunning(true))).toEqual([])
          run.setRunning(false)
          expect(changes(run, () => run.audition([c5]))).toEqual([])
          expect(changes(run, () => run.setRunning(true))).toEqual(only(on(kickNode, c5)))
          // Another, the first held on: the new one alone; the first let go of, alone too.
          expect(changes(run, () => run.audition([c5, e5]))).toEqual(only(on(snareNode, e5)))
          expect(changes(run, () => run.audition([e5]))).toEqual(only(off(kickNode, c5)))
          // None while the arrangement plays: let go of as it starts, pressed again as it stops.
          expect(changes(run, () => run.play(true))).toEqual(only(transport(true), off(snareNode, e5)))
          expect(changes(run, () => run.audition([e5, c5]))).toEqual([])
          expect(changes(run, () => run.play(false))).toEqual(
            only(transport(false), on(snareNode, e5), on(kickNode, c5))
          )
          // None of a track not heard, its notes let go of with it; heard again, pressed again.
          expect(changes(run, () => setMute(doc, by, tracks[0], true))).toEqual([
            {
              edits: [
                DeviceEdit.Disconnect({ from: kickNode, to: kickFader }),
                DeviceEdit.LetGoOfNotes({ node: kickNode })
              ],
              commands: [off(kickNode, c5)]
            }
          ])
          expect(changes(run, () => setMute(doc, by, tracks[0], false))).toEqual([
            { edits: [DeviceEdit.Connect({ from: kickNode, to: kickFader })], commands: [on(kickNode, c5)] }
          ])
          // A node made anew holds nothing: pressed on it again.
          const kickAgain = NodeHandle((1 << 16) | 1)
          expect(changes(run, () => setSound(doc, tracks[0], snare))).toEqual([
            {
              edits: [
                DeviceEdit.DestroyNode({ node: kickNode }),
                sampler(kickAgain, snare),
                DeviceEdit.Connect({ from: kickAgain, to: kickFader })
              ],
              commands: [on(kickAgain, c5)]
            }
          ])
          // A new engine is pressed what is held, on its nodes: the kick's cell a generation on again.
          const snareNext = NodeHandle((1 << 16) | 3)
          const {
            sent: [rebuilt]
          } = yield* rebuilding(run)
          expect(rebuilt.commands?.slice(-2)).toEqual([on(snareNext, e5), on(NodeHandle((2 << 16) | 1), c5)])
          // A track gone takes its notes with its nodes: nothing to let go of.
          expect(changes(run, () => deleteTrack(doc, by, tracks[1]))).toEqual([
            {
              edits: [
                DeviceEdit.DestroyNode({ node: snareNext }),
                DeviceEdit.DestroyNode({ node: NodeHandle((1 << 16) | 4) })
              ],
              commands: []
            }
          ])
        })
      )
  )

  it.effect('rebuilds a muted track joined to nothing and without its notes', () =>
    compiled((run) =>
      Effect.gen(function* () {
        const { doc, tracks, clip } = run
        addNote(doc, by, clip, step(0))
        const snare = Option.getOrThrow(addClip(doc, by, { track: tracks[1], tick: Tick(barTicks) }))
        addNote(doc, by, snare, step(2))
        setMute(doc, by, tracks[0], true)
        const next = (n: number) => NodeHandle((1 << 16) | n)
        const {
          sent: [rebuilt]
        } = yield* rebuilding(run)
        expect(rebuilt.edits).toContainEqual(sampler(next(1), kick))
        expect(rebuilt.edits).toContainEqual(DeviceEdit.Connect({ from: next(3), to: next(4) }))
        expect(rebuilt.edits).not.toContainEqual(DeviceEdit.Connect({ from: next(1), to: next(2) }))
        // The fader of a track not heard is still joined to the master: its meter just shows nothing.
        expect(rebuilt.edits).toContainEqual(DeviceEdit.Connect({ from: next(2), to: next(5) }))
        const patterns = (rebuilt.edits ?? []).filter(DeviceEdit.$is('SetPattern')).map(({ notes }) => notes)
        expect(patterns).toEqual(expect.arrayContaining([[], [played(next(3), 2)]]))
        expect(patterns).toHaveLength(2)
      })
    )
  )
  it.effect(
    "names each track's meter by its fader's handle while the track lasts, in the session the engine was last sent, and the one before",
    () =>
      compiled((run) =>
        Effect.gen(function* () {
          const { doc, tracks, compiler } = run
          const both = new Map([
            [kickFader, tracks[0]],
            [snareFader, tracks[1]]
          ])
          expect(compiler.meters(0)).toEqual(both)
          // Its instrument made anew and cut off, a track keeps its fader, and so its meter.
          setSound(doc, tracks[0], other)
          setMute(doc, by, tracks[0], true)
          expect(compiler.meters(0)).toBe(compiler.meters(0))
          expect(compiler.meters(0)).toEqual(both)
          // Not taken, a change names nothing new until the next one carries it.
          run.refuseNext()
          const added = Option.getOrThrow(addTrack(doc, by))
          expect(compiler.meters(0)).toEqual(both)
          deleteTrack(doc, by, tracks[1])
          const before = new Map([
            [kickFader, tracks[0]],
            [NodeHandle((1 << 16) | 3), added]
          ])
          expect(compiler.meters(0)).toEqual(before)
          // Until the engine takes the reset, its telemetry names the nodes of the session before.
          yield* rebuilding(run)
          expect(compiler.meters(1)).toEqual(
            new Map([
              [NodeHandle((1 << 16) | 2), tracks[0]],
              [NodeHandle((2 << 16) | 4), added]
            ])
          )
          expect(compiler.meters(0)).toEqual(before)
          yield* rebuilding(run)
          expect(compiler.meters(0)).toEqual(new Map())
          expect(compiler.meters(2).size).toBe(2)
        })
      )
  )

  it.effect('gives a track and a slot keyed master nodes of their own, apart from the master', () =>
    compiled((run) =>
      Effect.sync(() => {
        const { doc } = run
        const instrument = new Y.Map<unknown>(
          Object.entries({
            plugin: { id: plugins.sampler.id, version: plugins.sampler.version },
            params: new Y.Map(),
            samples: new Y.Map(Object.entries({ sample: kick }))
          })
        )
        const [masterTrack, itsFader] = [8, 9].map(cell)
        expect(
          changes(run, () =>
            doc.transact(() =>
              doc
                .getMap('tracks')
                .set('master', new Y.Map(Object.entries({ name: 'Tom', order: '~', deleted: false, instrument })))
            )
          )
        ).toEqual([
          {
            edits: [
              sampler(masterTrack, kick),
              trackFader(itsFader),
              DeviceEdit.Connect({ from: masterTrack, to: itsFader }),
              DeviceEdit.Connect({ from: itsFader, to: master })
            ],
            commands: []
          }
        ])
        const slot = cell(10)
        expect(changes(run, () => addSlot(doc, 'master', '~'))).toEqual([
          {
            edits: [
              createNode(plugins.filter, slot, { cutoff: 1000 }),
              DeviceEdit.Disconnect({ from: filter, to: masterFader }),
              DeviceEdit.Connect({ from: filter, to: slot }),
              DeviceEdit.Connect({ from: slot, to: masterFader })
            ],
            commands: []
          }
        ])
      })
    )
  )

  it.effect('tries a sound the engine never got again on a rebuild, and not on every change', () =>
    compiled((run) =>
      Effect.gen(function* () {
        const { doc, tracks } = run
        const missing = () => run.shown.filter(([hash, status]) => hash === other && status === 'Missing').length
        setSound(doc, tracks[0], other)
        yield* settled(run)
        setTrackStrip(doc, by, tracks[1], 'volume', 0.5)
        yield* settled(run)
        expect(missing()).toBe(1)
        yield* run.compiler.rebuild
        yield* settled(run)
        expect(missing()).toBe(2)
        expect(run.stored).toEqual([kick, snare])
      })
    )
  )

  it.effect('fails once building hits a bug, and whoever changed the project gets no error', () =>
    compiled((run) =>
      Effect.gen(function* () {
        run.breakSending()
        // The change goes through: the bug is the compiler's.
        setTempo(run.doc, by, 90)
        expect(Option.exists(yield* endedNow(run.compiler.failure), Exit.hasDies)).toBe(true)
        expect(Option.exists(yield* endedNow(run.compiler.stored), Exit.hasDies)).toBe(true)
      })
    )
  )

  it.effect('fails a rebuild that hits a bug, and itself with it', () =>
    compiled((run) =>
      Effect.gen(function* () {
        run.breakSending()
        expect(Option.exists(yield* endedNow(run.compiler.rebuild), Exit.hasDies)).toBe(true)
        expect(Option.exists(yield* endedNow(run.compiler.failure), Exit.hasDies)).toBe(true)
      })
    )
  )

  it.effect('fails to compile when the first build hits a bug', () =>
    Effect.gen(function* () {
      expect(Exit.hasDies(yield* Effect.exit(compiled(() => Effect.void, { broken: true })))).toBe(true)
    })
  )
})
