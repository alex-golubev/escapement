import { plugins, Sha256, Tick } from '@escapement/engine-description'
import { Array, Boolean, Option } from 'effect'
import type { Atom, AtomRegistry } from 'effect/reactivity'
import * as Y from 'yjs'
import { addClip, addTrack, createProject, type Id, newWriter, type Project, readProject, renameTrack } from '../src'
import { notesName, projectMaps } from '../src/document'

/** The drums tests put on tracks, each a sampler playing its sound. */
export const drums = ['Kick', 'Snare', 'Hat', 'Clap'].map((name, i) => ({ name, sound: Sha256(`${i}a`.repeat(32)) }))

/** Each of a synth's parameters at its default, as a new one reads. */
export const synthDefaults = Object.fromEntries(plugins.synth.params.map((param) => [param.id, param.default]))

/** Who writes in tests, unless one says otherwise. */
export const by = newWriter('test')

/** A new document holding a new project, as the page makes one: only the master. */
export const emptyProject = () => {
  const doc = new Y.Doc()
  return Boolean.match(createProject(doc, by), {
    onTrue: () => doc,
    onFalse: () => {
      throw new Error('The document already holds a project')
    }
  })
}

/** A track playing the sound with a sampler, named so; its ID. */
export const addDrum = (doc: Y.Doc, { name, sound }: (typeof drums)[number]) => {
  const track = Option.getOrThrow(addTrack(doc, by, { plugin: plugins.sampler, sounds: { sample: sound } }))
  renameTrack(doc, by, track, name)
  return track
}

/** The filter on the master, as no operation puts an effect anywhere yet. */
export const putFilterOnMaster = (doc: Y.Doc) =>
  doc.transact(() => {
    const slot = new Y.Map<unknown>(
      Object.entries({
        plugin: { id: plugins.filter.id, version: plugins.filter.version },
        params: new Y.Map(),
        samples: new Y.Map(),
        order: 'a0',
        deleted: false
      })
    )
    projectMaps(doc).master.set('slots', new Y.Map<unknown>([['filter', slot]]))
  })

/** A new project as tests start from: a track for each drum, in their order, a clip on the first, and the master's filter. */
export const newProject = () => {
  const doc = emptyProject()
  const [kick] = drums.map((drum) => addDrum(doc, drum))
  Option.getOrThrow(addClip(doc, by, { track: kick, tick: Tick(0) }))
  putFilterOnMaster(doc)
  return doc
}

export const projectOf = (doc: Y.Doc): Project => readProject(doc).value

export const replacementsOf = (doc: Y.Doc) => readProject(doc).replacements

/** The first track, the earliest clip and the first master slot, as tests act on them. */
export const parts = (doc: Y.Doc) => {
  const { tracks, clips, master } = projectOf(doc)
  return { track: tracks[0], clip: clips.toSorted((a, b) => a.tick - b.tick)[0], slot: master.slots[0] }
}

/** A new project with a synth after the drums, added as + adds it: a sampler has no knob of its own to turn. */
export const newProjectWithSynth = () => {
  const doc = newProject()
  Option.getOrThrow(addTrack(doc, by))
  return doc
}

/** The first track a synth plays, if any. */
const firstSynth = (doc: Y.Doc) =>
  Array.findFirst(projectOf(doc).tracks, ({ instrument }) => Option.exists(instrument, ({ name }) => name === 'synth'))

/** The first track a synth plays. */
export const synthOf = (doc: Y.Doc) => Option.getOrThrow(firstSynth(doc))

/** The first synth's shape, if there is one. */
export const shapeOf = (doc: Y.Doc) =>
  firstSynth(doc).pipe(
    Option.flatMap(({ instrument }) => instrument),
    Option.filter((instrument) => instrument.name === 'synth'),
    Option.map(({ params }) => params['osc1.shape']),
    Option.getOrUndefined
  )

/** The first master slot's cutoff, if it is a filter. */
export const cutoffOf = (doc: Y.Doc) =>
  Option.fromUndefinedOr(projectOf(doc).master.slots[0]).pipe(
    Option.filter((slot) => slot.name === 'filter'),
    Option.map(({ params }) => params.cutoff),
    Option.getOrUndefined
  )

/** A map of the document as any client could reach it, to write what this build never writes. */
export const rawMap = (doc: Y.Doc, root: string, ...keys: ReadonlyArray<string>): Y.Map<unknown> =>
  keys.reduce<Y.Map<unknown>>(
    (map, key) =>
      Option.getOrThrowWith(
        Option.liftPredicate(map.get(key), (next) => next instanceof Y.Map),
        () => new Error(`No map under ${key}`)
      ),
    doc.getMap(root)
  )

/** The map of the pattern's notes, as any client could reach it. */
export const rawNotes = (doc: Y.Doc, pattern: Id): Y.Map<unknown> => doc.getMap(notesName(pattern))

/** Each way a map can read as empty: not there, or something else in its place. */
export const brokenWays = [
  (map: Y.Map<unknown>, key: string) => map.delete(key),
  (map: Y.Map<unknown>, key: string) => map.set(key, 'x')
]

/** How many updates `act` makes the document send. */
export const updatesDuring = (doc: Y.Doc, act: () => void) => {
  const count = { updates: 0 }
  const listener = () => {
    count.updates += 1
  }
  doc.on('update', listener)
  act()
  doc.off('update', listener)
  return count.updates
}

/** Both documents get each other's changes, as when two clients connect. */
export const sync = (a: Y.Doc, b: Y.Doc) => {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)))
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)))
}

/** Each value the atom tells its subscriber, from the one it has now. */
export const told = <A>(registry: AtomRegistry.AtomRegistry, atom: Atom.Atom<A>) => {
  const values: Array<A> = []
  registry.subscribe(atom, (value) => values.push(value), { immediate: true })
  return values
}
