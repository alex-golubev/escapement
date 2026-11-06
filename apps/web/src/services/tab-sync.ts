import { type Holds, heldOver, heldValue, noHolds, readHolds, readProjectId } from '@escapement/model'
import {
  Boolean,
  Cause,
  Clock,
  Context,
  Data,
  Duration,
  Effect,
  FiberHandle,
  FiberSet,
  Layer,
  Option,
  Ref,
  Schema,
  type Scope
} from 'effect'
import { Atom, AtomRegistry } from 'effect/reactivity'
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness'
import * as sync from 'y-protocols/sync'
import type * as Y from 'yjs'
import { Page } from './page'
import { storageName } from './project-store'
import { ProjectSession } from './session'

/** The form of the messages: tabs of builds that read them otherwise meet on channels of their own. */
const messageForm = 2

// What a message carries, by the number it starts with, as y-websocket numbers them.
const syncMessage = 0
export const presenceMessage = 1
const presenceAsked = 3

/** A turn goes to the other tabs at most this often, its latest value each time: 25 times a second. */
const presenceInterval = Duration.millis(40)

/** What another tab sent can't be read. Every tab runs the same code, so the page logs it and goes on. */
export class TabMessageBroken extends Data.TaggedError('TabMessageBroken')<{
  readonly message: string
  readonly cause?: unknown
}> {}

/** lib0 throws on bytes that end too soon. */
const decoded = <A>(read: () => A) =>
  Effect.try({
    try: read,
    catch: (cause) => new TabMessageBroken({ message: 'A message from another tab is broken', cause })
  })

/** Bytes are all a message is. */
const bytesOf = (data: unknown) =>
  Schema.decodeUnknownEffect(Schema.Uint8Array)(data).pipe(
    Effect.mapError((cause) => new TabMessageBroken({ message: 'Another tab sent what is no message', cause }))
  )

/** Subscribed until the scope closes. */
const subscribed = (subscribe: () => () => void) =>
  Effect.acquireRelease(Effect.sync(subscribe), (unsubscribe) => Effect.sync(unsubscribe))

/** A channel between this browser's tabs: what one posts, each other one on it hears. */
export interface TabChannel {
  readonly post: (message: Uint8Array) => void
  /** Hears each message, until the function given back is called. */
  readonly listen: (heard: (message: unknown) => void) => () => void
}

/** The channels between this browser's tabs, each by its name, open while the scope is. */
export interface TabChannels {
  readonly open: (name: string) => Effect.Effect<TabChannel, never, Scope.Scope>
}

export const TabChannels = Context.Service<TabChannels>('TabChannels')

/** What the page brings to the channel: its document, and its presence, which tells the controls it holds. */
interface Tab {
  readonly doc: Y.Doc
  readonly awareness: Awareness
  readonly registry: AtomRegistry.AtomRegistry
  readonly holds: Atom.Atom<Holds>
  readonly heldElsewhere: Atom.Writable<Holds>
  /** Whether the page is shown: one hidden, closed or in the browser's cache, holds nothing for the others. */
  readonly shown: Atom.Atom<boolean>
}

interface PresenceChanges {
  readonly added: ReadonlyArray<number>
  readonly updated: ReadonlyArray<number>
  readonly removed: ReadonlyArray<number>
}

/**
 * Keeps the tab in step with every other tab on the channel `opening` opens, while the scope is open. On joining, it asks them
 * for what its document lacks and gives them all it has; then each change goes to them as it is made, whoever made it.
 * Its holds go to them as its presence, and theirs come into `heldElsewhere`. A message that can't be read is logged
 * and left out. The scope's end leaves: the others let go of its holds at once, and it of theirs. Ends only by failing,
 * on a bug in what the callbacks do.
 */
const join = Effect.fnUntraced(function* (
  opening: Effect.Effect<TabChannel, never, Scope.Scope>,
  { doc, awareness, registry, holds, heldElsewhere, shown }: Tab
) {
  const channel = yield* opening
  // What the callbacks do happens at once, and a bug in it ends the stay, as one in a publish that waited does.
  const callbacks = yield* FiberSet.make<void, never>()
  const run = yield* FiberSet.runtime(callbacks)()

  const post = (kind: number, write: (encoder: encoding.Encoder) => void) => {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, kind)
    write(encoder)
    channel.post(encoding.toUint8Array(encoder))
  }
  const sendPresence = () =>
    post(presenceMessage, (encoder) =>
      encoding.writeVarUint8Array(encoder, encodeAwarenessUpdate(awareness, [awareness.clientID]))
    )
  const changed = ({ added, updated, removed }: PresenceChanges) => [...added, ...updated, ...removed]
  // By client in order, so every tab plays the same one of two holding a control.
  const readOthers = () =>
    registry.set(
      heldElsewhere,
      Array.from(awareness.getStates())
        .filter(([client]) => client !== awareness.clientID)
        .sort(([a], [b]) => a - b)
        .reduce<Holds>((held, [, state]) => heldOver(held, readHolds(state.holds)), noHolds)
    )

  const readers: Partial<
    Record<number, (decoder: decoding.Decoder, reply: encoding.Encoder) => Effect.Effect<void, TabMessageBroken>>
  > = {
    [syncMessage]: (decoder, reply) =>
      decoded(() => {
        encoding.writeVarUint(reply, syncMessage)
        // An update that doesn't apply is logged by y-protocols, which goes on.
        sync.readSyncMessage(decoder, reply, doc, channel)
      }),
    // Presence breaking off midway keeps what it told before, and tells no one: what plays follows what is kept.
    [presenceMessage]: (decoder) =>
      decoded(() => applyAwarenessUpdate(awareness, decoding.readVarUint8Array(decoder), channel)).pipe(
        Effect.ensuring(Effect.sync(readOthers))
      ),
    // Told anew: a tab that left forgot it, and takes only a newer one.
    [presenceAsked]: () => Effect.sync(() => awareness.setLocalState(awareness.getLocalState()))
  }
  const read = (data: unknown) =>
    Effect.gen(function* () {
      const decoder = decoding.createDecoder(yield* bytesOf(data))
      const kind = yield* decoded(() => decoding.readVarUint(decoder))
      const reader = yield* Effect.fromOption(
        Option.fromNullishOr(readers[kind]),
        () => new TabMessageBroken({ message: `No message is of kind ${kind}` })
      )
      const reply = encoding.createEncoder()
      yield* reader(decoder, reply)
      // More than the kind: an answer.
      yield* Effect.sync(() => channel.post(encoding.toUint8Array(reply))).pipe(
        Effect.when(Effect.succeed(encoding.length(reply) > 1))
      )
    }).pipe(Effect.catchTag('TabMessageBroken', Effect.logError))

  yield* subscribed(() => channel.listen((message) => run(read(message))))
  yield* subscribed(() => {
    // What came from the other tabs is theirs already.
    const sendChange = (update: Uint8Array, origin: unknown) =>
      run(
        Effect.sync(() => post(syncMessage, (encoder) => sync.writeUpdate(encoder, update))).pipe(
          Effect.when(Effect.succeed(origin !== channel))
        )
      )
    doc.on('update', sendChange)
    return () => doc.off('update', sendChange)
  })
  yield* subscribed(() => {
    // Each tab tells only its own, also when another tab told it gone: y-protocols moves its clock on to say it isn't.
    const presenceChanged = (changes: PresenceChanges) =>
      run(Effect.sync(sendPresence).pipe(Effect.when(Effect.succeed(changed(changes).includes(awareness.clientID)))))
    awareness.on('update', presenceChanged)
    return () => awareness.off('update', presenceChanged)
  })
  yield* subscribed(() => {
    const othersChanged = (changes: PresenceChanges) =>
      run(
        Effect.sync(readOthers).pipe(
          Effect.when(Effect.succeed(changed(changes).some((client) => client !== awareness.clientID)))
        )
      )
    awareness.on('change', othersChanged)
    return () => awareness.off('change', othersChanged)
  })
  // Leaving, while the channel still takes what goes out.
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      awareness.setLocalState(null)
      removeAwarenessStates(
        awareness,
        Array.from(awareness.getStates().keys()).filter((client) => client !== awareness.clientID),
        channel
      )
    })
  )

  const published = yield* Ref.make({ holds: registry.get(holds), at: yield* Clock.monotonicTimeNanos })
  const waiting = yield* FiberHandle.make<void, never>()
  /** Tells the others what the page holds now; hidden, that it holds nothing. */
  const publish = Effect.gen(function* () {
    const now = registry.get(holds)
    yield* Ref.set(published, { holds: now, at: yield* Clock.monotonicTimeNanos })
    awareness.setLocalState(Boolean.match(registry.get(shown), { onTrue: () => ({ holds: now }), onFalse: () => null }))
  })
  /** In place of one waiting for its time. */
  const publishNow = FiberHandle.clear(waiting).pipe(Effect.andThen(publish))
  // A control let go goes at once, after the document has its last value, so no tab plays an older one between.
  const holdsChanged = (now: Holds) =>
    Effect.gen(function* () {
      const told = yield* Ref.get(published)
      const since = Duration.nanos((yield* Clock.monotonicTimeNanos) - told.at)
      const wait = Duration.subtract(presenceInterval, since)
      const letGo = told.holds.some(({ target }) => Option.isNone(heldValue(now, target)))
      yield* Boolean.match(letGo || !Duration.isPositive(wait), {
        onTrue: () => publishNow,
        onFalse: () => FiberHandle.run(waiting, Effect.delay(publish, wait), { onlyIfMissing: true })
      })
    })

  yield* subscribed(() => registry.subscribe(holds, (now) => run(holdsChanged(now))))
  yield* Effect.sync(() => {
    post(syncMessage, (encoder) => sync.writeSyncStep1(encoder, doc))
    post(syncMessage, (encoder) => sync.writeSyncStep2(encoder, doc))
  })
  yield* subscribed(() => registry.subscribe(shown, () => run(publishNow), { immediate: true }))
  yield* Effect.sync(() => post(presenceAsked, () => {}))
  return yield* Effect.raceFirst(FiberSet.join(callbacks), FiberHandle.join(waiting)).pipe(Effect.andThen(Effect.never))
})

/**
 * Where the tabs of `doc`'s project keep in step under `name`: each project on a channel of its own, so two never merge,
 * as the new one a page shows since the saved one didn't load, or is missing. Projects made before projects had IDs
 * share one. Each form of the messages has channels of its own.
 */
export const projectChannel = (name: string, doc: Y.Doc) =>
  [name, `v${messageForm}`, ...Option.toArray(readProjectId(doc))].join('/')

export interface TabSync {
  /** Whether the page is in step with the other tabs of its project: unless asked otherwise, or a bug took it out. */
  readonly on: Atom.Atom<boolean>
  /**
   * Out of step and back, so what each tab did meanwhile can be seen to merge. Only the channel: a tab out of step still
   * saves to the storage the others share, which a reload, or y-indexeddb packing its records, reads back.
   */
  readonly toggle: Effect.Effect<void>
}

export const TabSync = Context.Service<TabSync>('TabSync')

/**
 * The page's document and holds in step with the other tabs of its project, on its channel under `name`, while the scope
 * is open. A page hidden, closed or in the browser's cache, holds nothing for them: they let go of its holds at once.
 * It stays on the channel, so Chrome drops one in its cache that a message comes to, and none comes back behind. A bug
 * in keeping in step is logged and takes the page out of step, as Sync off does; Sync on tries again.
 */
export const tabSyncOf = Effect.fnUntraced(function* (
  name: string,
  { doc, holds, heldElsewhere }: Pick<ProjectSession, 'doc' | 'holds' | 'heldElsewhere'>
) {
  const registry = yield* AtomRegistry.AtomRegistry
  const page = yield* Page
  const channels = yield* TabChannels
  const channel = projectChannel(name, doc)
  const awareness = yield* Effect.acquireRelease(
    Effect.sync(() => new Awareness(doc)),
    (awareness) => Effect.sync(() => awareness.destroy())
  )
  const on = Atom.make(true).pipe(Atom.keepAlive)
  const shown = Atom.make(true).pipe(Atom.keepAlive)
  yield* subscribed(() => {
    const hide = () => registry.set(shown, false)
    const show = () => registry.set(shown, true)
    page.addEventListener('pagehide', hide)
    page.addEventListener('pageshow', show)
    return () => {
      page.removeEventListener('pageshow', show)
      page.removeEventListener('pagehide', hide)
    }
  })
  const joined = yield* FiberHandle.make<void, never>()
  const inStep = Effect.scoped(
    join(channels.open(channel), { doc, awareness, registry, holds, heldElsewhere, shown })
  ).pipe(
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterruptsOnly(cause),
      (cause) =>
        Effect.logError('A bug took the page out of step with the other tabs', cause).pipe(
          Effect.andThen(Effect.sync(() => registry.set(on, false)))
        )
    )
  )
  const run = yield* FiberSet.makeRuntime<never>()
  // As it changes, so a page never joins twice.
  const follow = Boolean.match({
    onTrue: () => FiberHandle.run(joined, inStep, { onlyIfMissing: true }),
    onFalse: () => FiberHandle.clear(joined)
  })
  yield* subscribed(() => registry.subscribe(on, (now) => run(follow(now)), { immediate: true }))
  return {
    on,
    toggle: Effect.sync(() => registry.update(on, (now) => !now))
  } satisfies TabSync
})

export const tabSyncLayer = Layer.effect(
  TabSync,
  Effect.flatMap(ProjectSession, (session) => tabSyncOf(storageName, session))
)
