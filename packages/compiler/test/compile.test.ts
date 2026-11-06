import {
  Command,
  createInsert,
  createNode,
  DeviceEdit,
  LoopTicks,
  meterCount,
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
  Tick
} from '@escapement/engine-description'
import {
  addChannel,
  addClip,
  addNote,
  addPattern,
  barTicks,
  batchedState,
  insertCount,
  createProject,
  defaultChannelStrip,
  deleteChannel,
  deletePattern,
  followProject,
  HoldTarget,
  type Holds,
  holding,
  Id,
  lettingGo,
  moveClip,
  resizeClip,
  trimClip,
  newWriter,
  noHolds,
  noAuditions,
  newListening,
  type Auditions,
  readProject,
  setChannelInsert,
  setChannelParam,
  setChannelStrip,
  setInsertMute,
  setInsertStrip,
  setMasterParam,
  setMute,
  setTempo,
  stepTicks,
  toggledMode,
  toggledSolo,
  toggleStep
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

/** The handle a cell's first node gets: nodes are made channels first, then the master: its insert, slots and fader. */
const cell = (n: number) => NodeHandle(n)
const [kickNode, snareNode, insert, filter, masterFader] = [1, 2, 3, 4, 5].map(cell)

/** The handle the current pattern of a new project gets, the first one a clip plays. */
const firstPattern = PatternHandle(1)

/** The current pattern alone, from the start, for a bar or `length`. */
const alone = (pattern: PatternHandle, length = barTicks) =>
  DeviceEdit.SetClips({ clips: [{ tick: Tick(0), length, period: length, offset: 0, pattern }] })

/** A channel's sampler, with its strip: as a new channel has it, unless given. */
const sampler = (node: NodeHandle, sound: Sha256, strip: StripValues = defaultChannelStrip) =>
  createNode(plugins.sampler, node, {}, { sample: sound }, strip)

/** A new channel's strip with its volume at `volume`. */
const turnedTo = (volume: number): StripValues => ({ ...defaultChannelStrip, volume })

/** The transport of a pattern played alone, unless it plays the arrangement. */
const transport = (playing: boolean, loopTicks = barTicks, arrangement = false) =>
  Command.SetTransport({ playing, loopTicks: LoopTicks(loopTicks), arrangement })

interface Run {
  readonly doc: Y.Doc
  readonly channels: ReadonlyArray<Id>
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
  readonly solo: (channel: Id) => void
  /** The pattern this client chooses to hear. */
  readonly choose: (pattern: Id) => void
  /** The engine runs, or stops taking what is in the ring. */
  readonly setRunning: (running: boolean) => void
  /** This client turns a control to the value, or lets it go. */
  readonly hold: (target: HoldTarget, value?: number) => void
  /** This client plays the pattern, or stops it. */
  readonly play: (playing: boolean) => void
  /** This client plays these notes by hand now. */
  readonly audition: (auditions: Auditions) => void
  /** From Pattern to Arrangement, or back, in this client's listening. */
  readonly toggleMode: () => void
}

/** Once every store and show started so far has run: they run apart from the compiler. */
const settled = ({ compiler }: Run) => Effect.orDie(compiler.stored)

/** How the effect ended, if it ends at once; one still waiting is none. */
const endedNow = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.map(Effect.forkChild(effect, { startImmediately: true }), (fiber) =>
    Option.fromUndefinedOr(fiber.pollUnsafe())
  )

/**
 * Compiles a project of the two sounds while `use` runs, into an engine that keeps what it was sent. Each sound is in
 * once `storing` ends.
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
  createProject(doc, by, sounds)
  const { channels, patterns, master } = readProject(doc).value
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
      channels: channels.map(({ id }) => id),
      pattern: patterns[0].id,
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
      solo: (channel) => registry.update(listening, (state) => toggledSolo(state, channel)),
      choose: (pattern) => registry.update(listening, (state) => ({ ...state, pattern: Option.some(pattern) })),
      setRunning: (value) => registry.set(running, value),
      hold: (target, value) =>
        registry.update(holds, (held) =>
          Option.match(Option.fromUndefinedOr(value), {
            onNone: () => lettingGo(held, target),
            onSome: (value) => holding(held, target, value)
          })
        ),
      play: (value) => registry.set(playing, value),
      audition: (value) => registry.set(auditions, value),
      toggleMode: () => registry.update(listening, toggledMode)
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

const setSound = (doc: Y.Doc, channel: Id, sound: Sha256) =>
  doc.transact(() => {
    const instrument = Option.getOrThrowWith(
      Option.liftPredicate(doc.getMap('channels').get(channel), (instrument) => instrument instanceof Y.Map),
      () => new Error('No channel')
    )
    const samples = (instrument.get('instrument') as Y.Map<Y.Map<unknown>>).get('samples')
    samples?.set('sample', sound)
  })

const slotMap = (doc: Y.Doc) => doc.getMap('mixer/master').get('slots') as Y.Map<Y.Map<unknown>>

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
  it("gives every mixer strip a meter of its own on the engine's board", () => {
    expect(insertCount).toBeLessThanOrEqual(meterCount)
  })

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
          const { doc, channels, pattern } = run
          expect(run.sent).toHaveLength(1)
          toggleStep(doc, by, pattern, channels[0], 0)
          setChannelStrip(doc, by, channels[1], 'volume', 0.3)
          setSound(doc, channels[1], other)
          expect(run.sent).toHaveLength(1)
          yield* settled(run)
          expect(run.stored).toEqual([kick, snare])
          expect(run.evicted).toEqual([snare])
          const snareAgain = NodeHandle((1 << 16) | 2)
          expect(changes(run, () => run.setRunning(true))).toEqual([
            {
              edits: [
                DeviceEdit.DestroyNode({ node: snareNode }),
                sampler(snareAgain, other, turnedTo(0.3)),
                DeviceEdit.Connect({ from: snareAgain, to: insert }),
                DeviceEdit.SetPattern({
                  pattern: firstPattern,
                  notes: [{ tick: Tick(0), node: kickNode, key: MidiKey(60), velocity: 1, length: stepTicks }]
                })
              ],
              commands: []
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
          // A synth, as + adds it, in the next cell: a sampler has no parameter of its own.
          changes(run, () => addChannel(doc, by))
          const synth = Option.getOrThrow(Option.fromUndefinedOr(readProject(doc).value.channels.at(-1))).id
          const synthNode = cell(6)
          const shape = HoldTarget.ChannelParam({ channel: synth, param: 'osc1.shape' })
          expect(changes(run, () => run.hold(shape, 1))).toEqual([
            { edits: [], commands: [setParam(plugins.synth, synthNode, 'osc1.shape', 1)] }
          ])
          expect(changes(run, () => setChannelParam(doc, by, synth, 'osc1.shape', 0))).toEqual([])
          expect(changes(run, () => run.hold(shape, 2))).toEqual([
            { edits: [], commands: [setParam(plugins.synth, synthNode, 'osc1.shape', 2)] }
          ])
          setChannelParam(doc, by, synth, 'osc1.shape', 2)
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
          expect(
            changes(run, () => run.hold(HoldTarget.ChannelParam({ channel: synth, param: 'cutoff' }), 500))
          ).toEqual([])
          expect(
            changes(run, () => run.hold(HoldTarget.ChannelParam({ channel: run.channels[0], param: 'osc1.shape' }), 1))
          ).toEqual([])
        })
      )
  )

  it.effect(
    "plays a channel's strip on its node, a held value over the document's, and makes a node anew with it",
    () =>
      compiled((run) =>
        Effect.sync(() => {
          const { doc, channels } = run
          expect(changes(run, () => setChannelStrip(doc, by, channels[0], 'pan', -0.5))).toEqual([
            { edits: [], commands: [setStripParam(kickNode, 'pan', -0.5)] }
          ])
          const volume = HoldTarget.ChannelStrip({ channel: channels[0], param: 'volume' })
          expect(changes(run, () => run.hold(volume, 0.3))).toEqual([
            { edits: [], commands: [setStripParam(kickNode, 'volume', 0.3)] }
          ])
          expect(changes(run, () => setChannelStrip(doc, by, channels[0], 'volume', 0.25))).toEqual([])
          // As the document's would read: in range, and a number.
          expect(changes(run, () => run.hold(volume, 5))).toEqual([
            { edits: [], commands: [setStripParam(kickNode, 'volume', 1)] }
          ])
          expect(changes(run, () => run.hold(volume, Number.NaN))).toEqual([
            { edits: [], commands: [setStripParam(kickNode, 'volume', 0.25)] }
          ])
          expect(changes(run, () => run.hold(volume))).toEqual([])
          const kickAgain = NodeHandle((1 << 16) | 1)
          expect(changes(run, () => setSound(doc, channels[0], other))).toEqual([
            {
              edits: [
                DeviceEdit.DestroyNode({ node: kickNode }),
                sampler(kickAgain, other, { volume: 0.25, pan: -0.5 }),
                DeviceEdit.Connect({ from: kickAgain, to: insert })
              ],
              commands: []
            }
          ])
        })
      )
  )

  it.effect('holds the changes again once the engine stops running, and a rebuild with them', () =>
    compiled((run) =>
      Effect.gen(function* () {
        const { doc, channels } = run
        run.setRunning(false)
        setChannelStrip(doc, by, channels[0], 'volume', 0.1)
        setChannelStrip(doc, by, channels[0], 'volume', 0.2)
        expect(yield* rebuilding(run)).toEqual({ taken: true, sent: [] })
        const [rebuilt] = changes(run, () => run.setRunning(true))
        expect(rebuilt.edits?.[0]).toEqual(DeviceEdit.Reset({ epoch: 1 }))
        expect(rebuilt.edits).toContainEqual(sampler(NodeHandle((1 << 16) | 1), kick, turnedTo(0.2)))
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
              sampler(snareNode, snare),
              createInsert(insert),
              createNode(plugins.filter, filter, { cutoff: 20000 }),
              createInsert(masterFader),
              DeviceEdit.Connect({ from: kickNode, to: insert }),
              DeviceEdit.Connect({ from: snareNode, to: insert }),
              DeviceEdit.Connect({ from: insert, to: filter }),
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
        const { doc, channels, pattern, slot } = run
        expect(changes(run, () => setChannelStrip(doc, by, channels[1], 'volume', 0.3))).toEqual([
          { edits: [], commands: [setStripParam(snareNode, 'volume', 0.3)] }
        ])
        expect(changes(run, () => setMasterParam(doc, by, slot, 'cutoff', 500))).toEqual([
          { edits: [], commands: [setParam(plugins.filter, filter, 'cutoff', 500)] }
        ])
        expect(changes(run, () => setTempo(doc, by, 90))).toEqual([
          { edits: [], commands: [Command.SetTempo({ bpm: 90 })] }
        ])
        toggleStep(doc, by, pattern, channels[0], 0)
        const [change] = changes(run, () => toggleStep(doc, by, pattern, channels[1], 2))
        const [edit] = change.edits ?? []
        expect(change.commands).toEqual([])
        expect(edit?._tag === 'SetPattern' && edit.notes.toSorted((a, b) => a.tick - b.tick)).toEqual([
          { tick: Tick(0), node: kickNode, key: MidiKey(60), velocity: 1, length: stepTicks },
          { tick: Tick(2 * stepTicks), node: snareNode, key: MidiKey(60), velocity: 1, length: stepTicks }
        ])
      })
    )
  )

  it.effect('makes a channel anew in a fresh cell when its sound changes, and swaps the sounds', () =>
    compiled((run) =>
      Effect.gen(function* () {
        const { doc, channels, pattern } = run
        toggleStep(doc, by, pattern, channels[0], 0)
        setChannelStrip(doc, by, channels[0], 'volume', 0.5)
        const kickAgain = NodeHandle((1 << 16) | 1)
        expect(changes(run, () => setSound(doc, channels[0], snare))).toEqual([
          {
            edits: [
              DeviceEdit.DestroyNode({ node: kickNode }),
              sampler(kickAgain, snare, turnedTo(0.5)),
              DeviceEdit.Connect({ from: kickAgain, to: insert }),
              DeviceEdit.SetPattern({
                pattern: firstPattern,
                notes: [{ tick: Tick(0), node: kickAgain, key: MidiKey(60), velocity: 1, length: stepTicks }]
              })
            ],
            commands: []
          }
        ])
        expect(run.evicted).toEqual([kick])
        setSound(doc, channels[1], other)
        expect(run.evicted).toEqual([kick])
        setSound(doc, channels[0], other)
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
        const first = cell(6)
        expect(changes(run, () => addSlot(doc, 'first', ' '))).toEqual([
          {
            edits: [
              createNode(plugins.filter, first, { cutoff: 1000 }),
              DeviceEdit.Disconnect({ from: insert, to: filter }),
              DeviceEdit.Connect({ from: insert, to: first }),
              DeviceEdit.Connect({ from: first, to: filter })
            ],
            commands: []
          }
        ])
        expect(changes(run, () => doc.transact(() => slotMap(doc).get('first')?.set('order', '~')))).toEqual([
          {
            edits: [
              DeviceEdit.Disconnect({ from: insert, to: first }),
              DeviceEdit.Disconnect({ from: first, to: filter }),
              DeviceEdit.Disconnect({ from: filter, to: masterFader }),
              DeviceEdit.Connect({ from: insert, to: filter }),
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
            edits: [DeviceEdit.DestroyNode({ node: filter }), DeviceEdit.Connect({ from: insert, to: masterFader })],
            commands: []
          }
        ])
      })
    )
  )

  it.effect('plays notes alike once, and none of a channel that has no node', () =>
    compiled((run) =>
      Effect.sync(() => {
        const { doc, channels, pattern } = run
        const note = (channel: string, key: number) => ({ channel, tick: 0, len: stepTicks, key, vel: 1 })
        const notes = doc.getMap(`notes/${pattern}`)
        doc.transact(() => {
          notes.set('b', note(channels[0], 60))
          notes.set('a', { ...note(channels[0], 60), vel: 0.5 })
          notes.set('c', note(channels[0], 62))
          notes.set('d', note('nowhere', 60))
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
        const channel = doc.getMap('channels').get(channels[0]) as Y.Map<unknown>
        expect(changes(run, () => doc.transact(() => channel.delete('instrument')))).toEqual([
          {
            edits: [
              DeviceEdit.DestroyNode({ node: kickNode }),
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
          const { doc, channels, pattern, play } = run
          const notes = doc.getMap(`notes/${pattern}`)
          play(true)
          doc.transact(() => {
            notes.set('b', { channel: channels[0], tick: barTicks - 1, len: stepTicks, key: 62, vel: 1 })
            notes.set('c', { channel: channels[0], tick: barTicks, len: stepTicks, key: 64, vel: 1 })
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
          doc.transact(() => notes.set('a', { channel: channels[0], tick: 0, len: 2 ** 32, key: 60, vel: 1 }))
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

  it.effect('plays the pattern this client chooses, its notes and loop; once it is gone, the one before it', () =>
    compiled((run) =>
      Effect.sync(() => {
        const { doc, channels, pattern, play, choose } = run
        play(true)
        toggleStep(doc, by, pattern, channels[0], 0)
        const chosen = Option.getOrThrow(addPattern(doc, by))
        const late = { tick: Tick(barTicks), key: MidiKey(64), length: stepTicks }
        // Not the current one yet: nothing it plays changes.
        expect(changes(run, () => addNote(doc, by, chosen, channels[1], late))).toEqual([])
        // The engine has only the pattern it plays: the one before goes, and its cell, in its next generation, is the new one's.
        const [inCell, again] = [1, 2].map((generation) => PatternHandle((generation << 16) | 1))
        expect(changes(run, () => choose(chosen))).toEqual([
          {
            edits: [
              DeviceEdit.DestroyPattern({ pattern: firstPattern }),
              DeviceEdit.SetPattern({ pattern: inCell, notes: [{ ...late, node: snareNode, velocity: 1 }] }),
              alone(inCell, 2 * barTicks)
            ],
            commands: [transport(true, 2 * barTicks)]
          }
        ])
        const entry = doc.getMap('patterns').get(chosen) as Y.Map<unknown>
        expect(changes(run, () => doc.transact(() => entry.set('deleted', true)))).toEqual([
          {
            edits: [
              DeviceEdit.DestroyPattern({ pattern: inCell }),
              DeviceEdit.SetPattern({
                pattern: again,
                notes: [{ tick: Tick(0), node: kickNode, key: MidiKey(60), velocity: 1, length: stepTicks }]
              }),
              alone(again)
            ],
            commands: [transport(true)]
          }
        ])
      })
    )
  )

  it.effect(
    "plays the arrangement in Arrangement mode: each pattern a clip plays once, and the loop to its last clip's bar",
    () =>
      compiled((run) =>
        Effect.sync(() => {
          const { doc, channels, pattern, play } = run
          play(true)
          toggleStep(doc, by, pattern, channels[0], 0)
          const second = Option.getOrThrow(addPattern(doc, by))
          addNote(doc, by, second, channels[1], { tick: Tick(barTicks), key: MidiKey(64), length: stepTicks })
          const place = (track: string, bar: number) => ({ track: Id(track), tick: Tick(bar * barTicks) })
          addClip(doc, by, pattern, place('1', 0))
          addClip(doc, by, second, place('2', 0))
          const moved = Option.getOrThrow(addClip(doc, by, second, place('1', 2)))
          const [arrangement] = changes(run, run.toggleMode)
          // The current pattern's notes are in already: only the other one goes, to a cell of its own.
          const other = PatternHandle(2)
          const snareAt = (tick: number) => ({
            tick: Tick(tick),
            node: snareNode,
            key: MidiKey(64),
            velocity: 1,
            length: stepTicks
          })
          expect(arrangement.edits?.at(0)).toEqual(
            DeviceEdit.SetPattern({ pattern: other, notes: [snareAt(barTicks)] })
          )
          expect(clipsIn(arrangement.edits?.at(1))).toEqual([
            { tick: Tick(0), length: barTicks, period: barTicks, offset: 0, pattern: firstPattern },
            { tick: Tick(0), length: 2 * barTicks, period: 2 * barTicks, offset: 0, pattern: other },
            { tick: Tick(2 * barTicks), length: 2 * barTicks, period: 2 * barTicks, offset: 0, pattern: other }
          ])
          expect(arrangement.edits).toHaveLength(2)
          expect(arrangement.commands).toEqual([transport(true, 4 * barTicks, true)])
          // A note of a pattern sends that pattern alone, however many clips play it.
          expect(
            changes(run, () =>
              addNote(doc, by, second, channels[1], { tick: Tick(0), key: MidiKey(64), length: stepTicks })
            )
          ).toEqual([
            {
              edits: [
                DeviceEdit.SetPattern({
                  pattern: other,
                  notes: expect.arrayContaining([snareAt(0), snareAt(barTicks)])
                })
              ],
              commands: []
            }
          ])
          // A clip moved sends the clips alone, and the loop as the arrangement's end moves.
          const [movedClip] = changes(run, () => moveClip(doc, by, moved, place('1', 4)))
          expect(movedClip.edits).toHaveLength(1)
          expect(clipsIn(movedClip.edits?.at(0)).at(-1)).toEqual({
            tick: Tick(4 * barTicks),
            length: 2 * barTicks,
            period: 2 * barTicks,
            offset: 0,
            pattern: other
          })
          expect(movedClip.commands).toEqual([transport(true, 6 * barTicks, true)])
          // A clip made longer than its pattern sends the clips alone, going round the pattern, and the loop to its end.
          const [longer] = changes(run, () => resizeClip(doc, by, moved, 5 * barTicks))
          expect(longer.edits).toHaveLength(1)
          expect(clipsIn(longer.edits?.at(0)).at(-1)).toEqual({
            tick: Tick(4 * barTicks),
            length: 5 * barTicks,
            period: 2 * barTicks,
            offset: 0,
            pattern: other
          })
          expect(longer.commands).toEqual([transport(true, 9 * barTicks, true)])
          // Trimmed at its start, from its pattern's second bar: the clips alone, the loop as it was.
          const trimmed = changes(run, () =>
            trimClip(doc, by, moved, { tick: Tick(5 * barTicks), length: 4 * barTicks, offset: barTicks })
          )
          expect(trimmed.map(({ edits }) => clipsIn(edits?.at(0)).at(-1))).toEqual([
            { tick: Tick(5 * barTicks), length: 4 * barTicks, period: 2 * barTicks, offset: barTicks, pattern: other }
          ])
          expect(trimmed.map(({ commands }) => commands)).toEqual([[]])
          // A pattern deleted takes its clips with it.
          const [deleted] = changes(run, () => deletePattern(doc, by, second))
          expect(deleted).toEqual({
            edits: [DeviceEdit.DestroyPattern({ pattern: other }), alone(firstPattern)],
            commands: [transport(true, barTicks, true)]
          })
          // Back in Pattern mode, the current pattern alone, as the arrangement now is: only what the loop plays
          // changes.
          expect(changes(run, run.toggleMode)).toEqual([{ edits: [], commands: [transport(true)] }])
        })
      )
  )

  it.effect("makes a pattern keyed as an object's own names are, as another client may write it, as any other", () =>
    compiled((run) =>
      Effect.sync(() => {
        const { doc, channels, choose } = run
        doc.transact(() => {
          doc.getMap('patterns').set('toString', new Y.Map(Object.entries({ name: 'Odd', order: '~', deleted: false })))
          doc.getMap('notes/toString').set('n', { channel: channels[0], tick: 0, len: stepTicks, key: 60, vel: 1 })
        })
        const inCell = PatternHandle((1 << 16) | 1)
        expect(changes(run, () => choose(Id('toString')))).toEqual([
          {
            edits: [
              DeviceEdit.DestroyPattern({ pattern: firstPattern }),
              DeviceEdit.SetPattern({
                pattern: inCell,
                notes: [{ tick: Tick(0), node: kickNode, key: MidiKey(60), velocity: 1, length: stepTicks }]
              }),
              alone(inCell)
            ],
            commands: []
          }
        ])
      })
    )
  )

  it.effect('carries a change the engine found no room for in the next one, and follows the sounds meanwhile', () =>
    compiled((run) =>
      Effect.gen(function* () {
        const { doc, channels } = run
        run.refuseNext()
        setChannelStrip(doc, by, channels[0], 'volume', 0.1)
        expect(changes(run, () => setChannelStrip(doc, by, channels[1], 'volume', 0.2))).toEqual([
          {
            edits: [],
            commands: [setStripParam(kickNode, 'volume', 0.1), setStripParam(snareNode, 'volume', 0.2)]
          }
        ])
        run.refuseNext()
        setSound(doc, channels[0], other)
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
        const { doc, channels, pattern } = run
        toggleStep(doc, by, pattern, channels[0], 0)
        yield* settled(run)
        const next = (n: number) => NodeHandle((1 << 16) | n)
        expect(yield* rebuilding(run)).toEqual({
          taken: true,
          sent: [
            {
              edits: [
                DeviceEdit.Reset({ epoch: 1 }),
                sampler(next(1), kick),
                sampler(next(2), snare),
                createInsert(next(3)),
                createNode(plugins.filter, next(4), { cutoff: 20000 }),
                createInsert(next(5)),
                DeviceEdit.Connect({ from: next(1), to: next(3) }),
                DeviceEdit.Connect({ from: next(2), to: next(3) }),
                DeviceEdit.Connect({ from: next(3), to: next(4) }),
                DeviceEdit.Connect({ from: next(4), to: next(5) }),
                DeviceEdit.SetOutput({ node: next(5) }),
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
  it.effect('mutes a channel: its notes leave the pattern, it is cut off, and it keeps its node and sound', () =>
    compiled((run) =>
      Effect.sync(() => {
        const { doc, channels, pattern } = run
        toggleStep(doc, by, pattern, channels[0], 0)
        const kick = { tick: Tick(0), node: kickNode, key: MidiKey(60), velocity: 1, length: stepTicks }
        expect(changes(run, () => setMute(doc, by, channels[0], true))).toEqual([
          {
            edits: [
              DeviceEdit.Disconnect({ from: kickNode, to: insert }),
              DeviceEdit.SetPattern({ pattern: firstPattern, notes: [] }),
              DeviceEdit.LetGoOfNotes({ node: kickNode })
            ],
            commands: []
          }
        ])
        expect(changes(run, () => setMute(doc, by, channels[0], false))).toEqual([
          {
            edits: [
              DeviceEdit.Connect({ from: kickNode, to: insert }),
              DeviceEdit.SetPattern({ pattern: firstPattern, notes: [kick] })
            ],
            commands: []
          }
        ])
        // Left out of a solo, the same, and back once the solo ends.
        const out = {
          edits: [
            DeviceEdit.Disconnect({ from: kickNode, to: insert }),
            DeviceEdit.SetPattern({ pattern: firstPattern, notes: [] }),
            DeviceEdit.LetGoOfNotes({ node: kickNode })
          ],
          commands: []
        }
        const back = {
          edits: [
            DeviceEdit.Connect({ from: kickNode, to: insert }),
            DeviceEdit.SetPattern({ pattern: firstPattern, notes: [kick] })
          ],
          commands: []
        }
        expect(changes(run, () => run.solo(channels[1]))).toEqual([out])
        expect(changes(run, () => run.solo(channels[1]))).toEqual([back])
        // Muted in the document, a solo brings it back, leaving the others out, and its end mutes it again.
        expect(changes(run, () => setMute(doc, by, channels[0], true))).toEqual([out])
        expect(changes(run, () => run.solo(channels[0]))).toEqual([
          {
            edits: [
              DeviceEdit.Disconnect({ from: snareNode, to: insert }),
              DeviceEdit.Connect({ from: kickNode, to: insert }),
              DeviceEdit.SetPattern({ pattern: firstPattern, notes: [kick] }),
              DeviceEdit.LetGoOfNotes({ node: snareNode })
            ],
            commands: []
          }
        ])
        expect(changes(run, () => run.solo(channels[0]))).toEqual([
          {
            edits: [
              DeviceEdit.Disconnect({ from: kickNode, to: insert }),
              DeviceEdit.Connect({ from: snareNode, to: insert }),
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

  it.effect("sends channels into an insert and back, and plays an insert's strip and mute, and the master's", () =>
    compiled((run) =>
      Effect.sync(() => {
        const { doc, channels } = run
        // What goes into it sums at its insert, then plays through its fader, the strip's meter numbered as it is.
        const [third, thirdFader] = [6, 7].map(cell)
        const into = (from: NodeHandle, to: NodeHandle) => DeviceEdit.Connect({ from, to })
        const outOf = (from: NodeHandle, to: NodeHandle) => DeviceEdit.Disconnect({ from, to })
        expect(changes(run, () => setChannelInsert(doc, by, channels[0], Id('3')))).toEqual([
          {
            edits: [
              createInsert(third, defaultStrip),
              createInsert(thirdFader, defaultStrip, Option.some(3)),
              outOf(kickNode, insert),
              into(kickNode, third),
              into(third, thirdFader),
              into(thirdFader, insert)
            ],
            commands: []
          }
        ])
        expect(changes(run, () => setChannelInsert(doc, by, channels[1], Id('3')))).toEqual([
          { edits: [outOf(snareNode, insert), into(snareNode, third)], commands: [] }
        ])
        expect(changes(run, () => setInsertStrip(doc, by, Id('3'), 'volume', 0.5))).toEqual([
          { edits: [], commands: [setStripParam(thirdFader, 'volume', 0.5)] }
        ])
        // Muted, it goes into the master no more, and its fader, made anew, has no meter: nothing of it goes on.
        const [mutedFader, heardFader] = [1, 2].map((generation) => NodeHandle((generation << 16) | 7))
        const faderAtHalf = { volume: 0.5, pan: 0 }
        expect(changes(run, () => setInsertMute(doc, by, Id('3'), true))).toEqual([
          {
            edits: [
              DeviceEdit.DestroyNode({ node: thirdFader }),
              createInsert(mutedFader, faderAtHalf),
              into(third, mutedFader)
            ],
            commands: []
          }
        ])
        expect(changes(run, () => setInsertMute(doc, by, Id('3'), false))).toEqual([
          {
            edits: [
              DeviceEdit.DestroyNode({ node: mutedFader }),
              createInsert(heardFader, faderAtHalf, Option.some(3)),
              into(third, heardFader),
              into(heardFader, insert)
            ],
            commands: []
          }
        ])
        // After its slots: the filter hears the master's sum as it is.
        expect(changes(run, () => setInsertStrip(doc, by, Id('master'), 'pan', -0.5))).toEqual([
          { edits: [], commands: [setStripParam(masterFader, 'pan', -0.5)] }
        ])
        // Held, the master's fader and the kick's insert play at once, and as the document has them once let go.
        const fader = HoldTarget.InsertStrip({ insert: Id('master'), param: 'volume' })
        expect(changes(run, () => run.hold(fader, 0.25))).toEqual([
          { edits: [], commands: [setStripParam(masterFader, 'volume', 0.25)] }
        ])
        expect(changes(run, () => run.hold(fader))).toEqual([
          { edits: [], commands: [setStripParam(masterFader, 'volume', 1)] }
        ])
        const route = HoldTarget.ChannelInsert({ channel: channels[0] })
        expect(changes(run, () => run.hold(route, 0.2))).toEqual([
          { edits: [outOf(kickNode, third), into(kickNode, insert)], commands: [] }
        ])
        expect(changes(run, () => run.hold(route))).toEqual([
          { edits: [outOf(kickNode, insert), into(kickNode, third)], commands: [] }
        ])
        // The last one out of it takes its node with it.
        expect(changes(run, () => setChannelInsert(doc, by, channels[0], Id('master')))).toEqual([
          { edits: [outOf(kickNode, third), into(kickNode, insert)], commands: [] }
        ])
        expect(changes(run, () => setChannelInsert(doc, by, channels[1], Id('master')))).toEqual([
          {
            edits: [
              DeviceEdit.DestroyNode({ node: third }),
              DeviceEdit.DestroyNode({ node: heardFader }),
              into(snareNode, insert)
            ],
            commands: []
          }
        ])
      })
    )
  )

  it.effect(
    "sends a channel left out into its insert once it is heard, and keeps an insert's node while one goes in",
    () =>
      compiled((run) =>
        Effect.sync(() => {
          const { doc, channels } = run
          const [third, thirdFader] = [6, 7].map(cell)
          setMute(doc, by, channels[0], true)
          expect(changes(run, () => setChannelInsert(doc, by, channels[0], Id('3')))).toEqual([
            {
              edits: [
                createInsert(third, defaultStrip),
                createInsert(thirdFader, defaultStrip, Option.some(3)),
                DeviceEdit.Connect({ from: third, to: thirdFader }),
                DeviceEdit.Connect({ from: thirdFader, to: insert })
              ],
              commands: []
            }
          ])
          const [unmuted] = changes(run, () => setMute(doc, by, channels[0], false))
          expect(unmuted.edits?.slice(0, 1)).toEqual([DeviceEdit.Connect({ from: kickNode, to: third })])
        })
      )
  )

  it.effect('solos channels for this client only, muted in the document or not', () =>
    compiled((run) =>
      Effect.sync(() => {
        const { doc, channels } = run
        const updates = { count: 0 }
        doc.on('update', () => {
          updates.count += 1
        })
        setMute(doc, by, channels[1], true)
        expect(changes(run, () => run.solo(channels[1]))).toEqual([
          {
            edits: [
              DeviceEdit.Disconnect({ from: kickNode, to: insert }),
              DeviceEdit.Connect({ from: snareNode, to: insert }),
              DeviceEdit.LetGoOfNotes({ node: kickNode })
            ],
            commands: []
          }
        ])
        expect(changes(run, () => run.solo(channels[0]))).toEqual([
          { edits: [DeviceEdit.Connect({ from: kickNode, to: insert })], commands: [] }
        ])
        expect(changes(run, () => setMute(doc, by, channels[0], true))).toEqual([])
        expect(changes(run, () => run.solo(channels[1]))).toEqual([
          {
            edits: [
              DeviceEdit.Disconnect({ from: snareNode, to: insert }),
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
    'plays notes by hand on a channel heard while the pattern stops, from press to release, again on a node made anew',
    () =>
      compiled((run) =>
        Effect.gen(function* () {
          const { doc, channels } = run
          const c5 = { channel: channels[0], key: MidiKey(60), velocity: 1, press: 1 }
          const e5 = { channel: channels[1], key: MidiKey(64), velocity: 0.5, press: 2 }
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
          // None while the pattern plays: let go of as it starts, pressed again as it stops.
          expect(changes(run, () => run.play(true))).toEqual(only(transport(true), off(snareNode, e5)))
          expect(changes(run, () => run.audition([e5, c5]))).toEqual([])
          expect(changes(run, () => run.play(false))).toEqual(
            only(transport(false), on(snareNode, e5), on(kickNode, c5))
          )
          // None of a channel not heard, its notes let go of with it; heard again, pressed again.
          expect(changes(run, () => setMute(doc, by, channels[0], true))).toEqual([
            {
              edits: [
                DeviceEdit.Disconnect({ from: kickNode, to: insert }),
                DeviceEdit.LetGoOfNotes({ node: kickNode })
              ],
              commands: [off(kickNode, c5)]
            }
          ])
          expect(changes(run, () => setMute(doc, by, channels[0], false))).toEqual([
            { edits: [DeviceEdit.Connect({ from: kickNode, to: insert })], commands: [on(kickNode, c5)] }
          ])
          // A node made anew holds nothing: pressed on it again.
          const kickAgain = NodeHandle((1 << 16) | 1)
          expect(changes(run, () => setSound(doc, channels[0], snare))).toEqual([
            {
              edits: [
                DeviceEdit.DestroyNode({ node: kickNode }),
                sampler(kickAgain, snare),
                DeviceEdit.Connect({ from: kickAgain, to: insert })
              ],
              commands: [on(kickAgain, c5)]
            }
          ])
          // A new engine is pressed what is held, on its nodes: the kick's cell a generation on again.
          const snareNext = NodeHandle((1 << 16) | 2)
          const {
            sent: [rebuilt]
          } = yield* rebuilding(run)
          expect(rebuilt.commands?.slice(-2)).toEqual([on(snareNext, e5), on(NodeHandle((2 << 16) | 1), c5)])
          // A channel gone takes its notes with its node: nothing to let go of.
          expect(changes(run, () => deleteChannel(doc, by, channels[1]))).toEqual([
            { edits: [DeviceEdit.DestroyNode({ node: snareNext })], commands: [] }
          ])
        })
      )
  )

  it.effect('rebuilds a muted channel joined to nothing and without its notes', () =>
    compiled((run) =>
      Effect.gen(function* () {
        const { doc, channels, pattern } = run
        toggleStep(doc, by, pattern, channels[0], 0)
        toggleStep(doc, by, pattern, channels[1], 2)
        setMute(doc, by, channels[0], true)
        const next = (n: number) => NodeHandle((1 << 16) | n)
        const {
          sent: [rebuilt]
        } = yield* rebuilding(run)
        expect(rebuilt.edits).toContainEqual(sampler(next(1), kick))
        expect(rebuilt.edits).toContainEqual(DeviceEdit.Connect({ from: next(2), to: next(3) }))
        expect(rebuilt.edits).not.toContainEqual(DeviceEdit.Connect({ from: next(1), to: next(3) }))
        expect(rebuilt.edits).toContainEqual(
          DeviceEdit.SetPattern({
            pattern: PatternHandle((1 << 16) | 1),
            notes: [{ tick: Tick(2 * stepTicks), node: next(2), key: MidiKey(60), velocity: 1, length: stepTicks }]
          })
        )
      })
    )
  )
  it.effect('gives a channel and a slot keyed master nodes of their own, apart from the master insert', () =>
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
        const masterChannel = cell(6)
        expect(
          changes(run, () =>
            doc.transact(() =>
              doc
                .getMap('channels')
                .set('master', new Y.Map(Object.entries({ name: 'Tom', order: '~', deleted: false, instrument })))
            )
          )
        ).toEqual([
          {
            edits: [sampler(masterChannel, kick), DeviceEdit.Connect({ from: masterChannel, to: insert })],
            commands: []
          }
        ])
        const slot = cell(7)
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
        const { doc, channels } = run
        const missing = () => run.shown.filter(([hash, status]) => hash === other && status === 'Missing').length
        setSound(doc, channels[0], other)
        yield* settled(run)
        setChannelStrip(doc, by, channels[1], 'volume', 0.5)
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
