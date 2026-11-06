import { plugins, Sha256 } from '@escapement/engine-description'
import { Array, Boolean, Option } from 'effect'
import type { Atom, AtomRegistry } from 'effect/reactivity'
import * as Y from 'yjs'
import { addChannel, createProject, type Id, type NewChannel, newWriter, type Project, readProject } from '../src'
import { notesName } from '../src/document'

export const drums: ReadonlyArray<NewChannel> = ['Kick', 'Snare', 'Hat', 'Clap'].map((name, i) => ({
  name,
  sound: Sha256(`${i}a`.repeat(32))
}))

/** Each of a synth's parameters at its default, as a new one reads. */
export const synthDefaults = Object.fromEntries(plugins.synth.params.map((param) => [param.id, param.default]))

/** Who writes in tests, unless one says otherwise. */
export const by = newWriter('test')

/** A new document holding a new project. */
export const newProject = () => {
  const doc = new Y.Doc()
  return Boolean.match(createProject(doc, by, drums), {
    onTrue: () => doc,
    onFalse: () => {
      throw new Error('The document already holds a project')
    }
  })
}

export const projectOf = (doc: Y.Doc): Project => readProject(doc).value

export const replacementsOf = (doc: Y.Doc) => readProject(doc).replacements

/** The first channel, pattern and master slot, as tests act on them. */
export const parts = (doc: Y.Doc) => {
  const { channels, patterns, master } = projectOf(doc)
  return { channel: channels[0], pattern: patterns[0], slot: master.slots[0] }
}

/** A new project with a synth after the drums, added as + adds it: a sampler has no knob of its own to turn. */
export const newProjectWithSynth = () => {
  const doc = newProject()
  addChannel(doc, by)
  return doc
}

/** The first channel a synth plays, if any. */
const firstSynth = (doc: Y.Doc) =>
  Array.findFirst(projectOf(doc).channels, ({ instrument }) =>
    Option.exists(instrument, ({ name }) => name === 'synth')
  )

/** The first channel a synth plays. */
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
