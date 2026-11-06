import { MidiKey, plugins, Tick } from '@escapement/engine-description'
import { Effect, Option } from 'effect'
import { AtomRegistry } from 'effect/reactivity'
import { describe, expect, test } from 'vitest'
import * as Y from 'yjs'
import {
  barTicks,
  type Editor,
  editorOf,
  Id,
  moveClip,
  newWriter,
  type Project,
  setChannelParam,
  setMute,
  setTempo,
  stepTicks,
  toggleStep
} from '../src'
import {
  brokenWays,
  by,
  cutoffOf,
  newProject,
  newProjectWithSynth,
  parts,
  projectOf,
  rawMap,
  rawNotes,
  synthOf,
  sync,
  told,
  shapeOf,
  updatesDuring
} from './project'

/** Another client, or another part of this one, writing to the same document. */
const elsewhere = newWriter('elsewhere')

/** `by`'s editor while `use` runs, its atoms mounted as the page keeps them. */
const editing = <A>(doc: Y.Doc, use: (editor: Editor, registry: AtomRegistry.AtomRegistry) => A): A => {
  const registry = AtomRegistry.make()
  return Effect.runSync(
    editorOf(doc, by).pipe(
      Effect.map((editor) => {
        registry.mount(editor.canUndo)
        registry.mount(editor.canRedo)
        return use(editor, registry)
      }),
      Effect.scoped,
      Effect.provideService(AtomRegistry.AtomRegistry, registry)
    )
  )
}

/** Each document gets the other's changes as they happen, as two clients online do. */
const connect = (a: Y.Doc, b: Y.Doc) => {
  const connection = {}
  sync(a, b)
  a.on('update', (update: Uint8Array, origin: unknown) => origin !== connection && Y.applyUpdate(b, update, connection))
  b.on('update', (update: Uint8Array, origin: unknown) => origin !== connection && Y.applyUpdate(a, update, connection))
}

const notesOf = (doc: Y.Doc) => projectOf(doc).patterns[0].notes

describe('an editor', () => {
  test("takes back its writer's steps and none of another client's, here and there", () => {
    const here = newProjectWithSynth()
    const there = new Y.Doc()
    connect(here, there)
    const { channel, pattern } = parts(here)
    const synth = synthOf(here)
    editing(here, (editor) => {
      expect(editor.toggleStep(pattern.id, channel.id, 2)).toBe(true)
      expect(setChannelParam(there, elsewhere, synth.id, 'osc1.shape', 1)).toBe(true)
      expect(setTempo(there, elsewhere, 140)).toBe(true)
      expect(editor.undo()).toBe(true)
      const docs = [here, there]
      docs.forEach((doc) => {
        expect(notesOf(doc)).toEqual([])
        expect(shapeOf(doc)).toBe(1)
        expect(projectOf(doc).tempo).toBe(140)
      })
      expect(editor.undo()).toBe(false)
      expect(editor.redo()).toBe(true)
      expect(notesOf(there)).toHaveLength(1)
      expect(shapeOf(there)).toBe(1)
    })
  })

  test('takes back a channel added as one step, and brings it back', () => {
    const doc = newProject()
    editing(doc, (editor) => {
      expect(editor.addChannel()).toBe(true)
      expect(projectOf(doc).channels).toHaveLength(5)
      expect(editor.undo()).toBe(true)
      expect(projectOf(doc).channels).toHaveLength(4)
      expect(editor.redo()).toBe(true)
      expect(projectOf(doc).channels.at(-1)?.name).toBe('Synth')
    })
  })

  test('takes back a pattern added into the trash, with the notes another client put in it since; redo brings both', () => {
    const here = newProject()
    const there = new Y.Doc()
    connect(here, there)
    const { channel } = parts(here)
    const names = (doc: Y.Doc) => projectOf(doc).patterns.map(({ name }) => name)
    editing(here, (editor, registry) => {
      const added = Option.getOrThrow(editor.addPattern())
      expect(names(there)).toEqual(['Pattern 1', 'Pattern 2'])
      expect(toggleStep(there, elsewhere, added, channel.id, 3)).toBe(true)
      expect(editor.undo()).toBe(true)
      ;[here, there].forEach((doc) => {
        expect(names(doc)).toEqual(['Pattern 1'])
        expect(rawMap(doc, 'patterns', added).get('deleted')).toBe(true)
        expect(rawNotes(doc, added).size).toBe(1)
      })
      // Setting it up was no step: nothing is left to take back.
      expect(registry.get(editor.canUndo)).toBe(false)
      expect(editor.redo()).toBe(true)
      ;[here, there].forEach((doc) =>
        expect(projectOf(doc).patterns.map(({ id, notes }) => ({ id, ticks: notes.map(({ tick }) => tick) }))).toEqual([
          { id: parts(here).pattern.id, ticks: [] },
          { id: added, ticks: [3 * stepTicks] }
        ])
      )
    })
  })

  test('takes back a name as one step, and a deletion: the channel back in its place with its steps and knobs', () => {
    const doc = newProject()
    const { channel, pattern } = parts(doc)
    const names = () => projectOf(doc).channels.map(({ name }) => name)
    const before = names()
    editing(doc, (editor) => {
      expect(editor.toggleStep(pattern.id, channel.id, 2)).toBe(true)
      expect(editor.setChannelStrip(channel.id, 'pan', 2)).toBe(true)
      expect(editor.renameChannel(channel.id, 'Big kick')).toBe(true)
      expect(editor.deleteChannel(channel.id)).toBe(true)
      expect(names()).toEqual(before.slice(1))
      expect(editor.undo()).toBe(true)
      expect(names()).toEqual(['Big kick', ...before.slice(1)])
      expect(projectOf(doc).channels[0].strip.pan).toBe(1)
      expect(notesOf(doc).map((note) => note.channel)).toEqual([channel.id])
      expect(editor.undo()).toBe(true)
      expect(names()).toEqual(before)
      expect(editor.redo()).toBe(true)
      expect(editor.redo()).toBe(true)
      expect(names()).toEqual(before.slice(1))
    })
  })

  test('drops a step another client wrote over since, and then says it has nothing left to undo', () => {
    const here = newProjectWithSynth()
    const there = new Y.Doc()
    connect(here, there)
    const synth = synthOf(here)
    editing(here, (editor, registry) => {
      editor.setChannelParam(synth.id, 'osc1.shape', 2)
      setChannelParam(there, elsewhere, synth.id, 'osc1.shape', 1)
      expect(registry.get(editor.canUndo)).toBe(true)
      expect(editor.undo()).toBe(false)
      expect(shapeOf(here)).toBe(1)
      expect(registry.get(editor.canUndo)).toBe(false)
      expect(registry.get(editor.canRedo)).toBe(false)
    })
  })

  test('leaves out what another writer of the same document writes, and what its own wrote before it', () => {
    const doc = newProject()
    const { channel } = parts(doc)
    editing(doc, (editor, registry) => {
      expect(setMute(doc, elsewhere, channel.id, true)).toBe(true)
      expect(registry.get(editor.canUndo)).toBe(false)
      expect(editor.undo()).toBe(false)
      expect(projectOf(doc).channels[0].mute).toBe(true)
      expect(projectOf(doc).channels).toHaveLength(4)
    })
  })

  test('takes back each edit as a step of its own, however close together, and makes them again', () => {
    const doc = newProjectWithSynth()
    const { channel, pattern, slot } = parts(doc)
    const synth = synthOf(doc)
    const edits: ReadonlyArray<(editor: Editor) => boolean> = [
      (editor) => editor.toggleStep(pattern.id, channel.id, 1),
      (editor) => editor.toggleStep(pattern.id, channel.id, 2),
      (editor) => editor.toggleStep(pattern.id, channel.id, 1),
      (editor) => editor.setMute(channel.id, true),
      (editor) => editor.setTempo(150),
      (editor) => editor.setChannelParam(synth.id, 'osc1.shape', 0),
      (editor) => editor.setChannelStrip(channel.id, 'pan', -0.6),
      (editor) => editor.setChannelStrip(channel.id, 'volume', 0.7),
      (editor) => editor.setMasterParam(slot.id, 'cutoff', 500)
    ]
    editing(doc, (editor) => {
      const states: Array<Project> = [projectOf(doc)]
      edits.forEach((edit) => {
        expect(edit(editor)).toBe(true)
        states.push(projectOf(doc))
      })
      expect(cutoffOf(doc)).toBe(500)
      states
        .slice(0, -1)
        .reverse()
        .forEach((state) => {
          expect(editor.undo()).toBe(true)
          expect(projectOf(doc)).toEqual(state)
        })
      expect(editor.undo()).toBe(false)
      states.slice(1).forEach((state) => {
        expect(editor.redo()).toBe(true)
        expect(projectOf(doc)).toEqual(state)
      })
      expect(editor.redo()).toBe(false)
    })
  })

  test('takes back an action as one step to the value before it, however far apart its edits', () => {
    const doc = newProjectWithSynth()
    const synth = synthOf(doc)
    return Effect.gen(function* () {
      const registry = yield* AtomRegistry.AtomRegistry
      const editor = yield* editorOf(doc, by)
      const end = editor.begin()
      editor.setChannelParam(synth.id, 'osc1.shape', 0)
      // Past the half second Yjs would make a step of on its own, by the clock it reads.
      yield* Effect.sleep('600 millis')
      editor.setChannelParam(synth.id, 'osc1.shape', 1)
      editor.setChannelParam(synth.id, 'osc1.shape', 2)
      end()
      expect(editor.undo()).toBe(true)
      expect(shapeOf(doc)).toBe(plugins.synth.params[0].default)
      expect(registry.get(editor.canUndo)).toBe(false)
      expect(editor.redo()).toBe(true)
      expect(shapeOf(doc)).toBe(2)
    }).pipe(Effect.scoped, Effect.provideService(AtomRegistry.AtomRegistry, AtomRegistry.make()), Effect.runPromise)
  })

  test('makes one step of all it writes while actions are open: two at once, and edits between', () => {
    const doc = newProjectWithSynth()
    const { channel, pattern, slot } = parts(doc)
    const synth = synthOf(doc)
    editing(doc, (editor) => {
      const before = projectOf(doc)
      const endKnob = editor.begin()
      const endFilter = editor.begin()
      Array.from({ length: 10 }, (_, i) => i).forEach((i) => {
        editor.setChannelParam(synth.id, 'osc1.shape', i % 5)
        editor.setMasterParam(slot.id, 'cutoff', 1000 + i)
      })
      editor.setMute(channel.id, false)
      editor.toggleStep(pattern.id, channel.id, 0)
      endKnob()
      editor.setMasterParam(slot.id, 'cutoff', 2000)
      endFilter()
      expect(editor.undo()).toBe(true)
      expect(projectOf(doc)).toEqual(before)
      expect(editor.undo()).toBe(false)
    })
  })

  test('makes a step of each action after another, none of one that wrote nothing', () => {
    const doc = newProjectWithSynth()
    const synth = synthOf(doc)
    editing(doc, (editor) => {
      const turn = (values: ReadonlyArray<number>) => {
        const end = editor.begin()
        values.forEach((value) => editor.setChannelParam(synth.id, 'osc1.shape', value))
        end()
      }
      turn([0, 1])
      turn([])
      turn([2, 4])
      editor.undo()
      expect(shapeOf(doc)).toBe(1)
      editor.undo()
      expect(shapeOf(doc)).toBe(plugins.synth.params[0].default)
      expect(editor.undo()).toBe(false)
    })
  })

  test('adds and clones no pattern while an action is open, which would make it a step of the gesture', () => {
    const doc = newProject()
    const { pattern } = parts(doc)
    editing(doc, (editor) => {
      const end = editor.begin()
      expect(
        updatesDuring(doc, () => {
          expect(editor.addPattern()).toEqual(Option.none())
          expect(editor.clonePattern(pattern.id)).toEqual(Option.none())
        })
      ).toBe(0)
      end()
      expect(Option.isSome(editor.addPattern())).toBe(true)
      expect(Option.isSome(editor.clonePattern(pattern.id))).toBe(true)
      expect(projectOf(doc).patterns).toHaveLength(3)
    })
  })

  test("takes back a pattern's rename, clone and deletion, a step each; the clone goes to the trash with its notes", () => {
    const doc = newProject()
    const { channel, pattern } = parts(doc)
    const names = () => projectOf(doc).patterns.map(({ name }) => name)
    editing(doc, (editor) => {
      expect(editor.toggleStep(pattern.id, channel.id, 1)).toBe(true)
      expect(editor.renamePattern(pattern.id, 'Intro')).toBe(true)
      const clone = Option.getOrThrow(editor.clonePattern(pattern.id))
      expect(editor.deletePattern(pattern.id)).toBe(true)
      expect(names()).toEqual(['Intro #2'])
      expect(editor.undo()).toBe(true)
      expect(names()).toEqual(['Intro', 'Intro #2'])
      expect(editor.undo()).toBe(true)
      expect(names()).toEqual(['Intro'])
      expect(rawMap(doc, 'patterns', clone).get('deleted')).toBe(true)
      expect(rawNotes(doc, clone).size).toBe(1)
      expect(editor.undo()).toBe(true)
      expect(names()).toEqual(['Pattern 1'])
      expect(notesOf(doc)).toHaveLength(1)
      ;[1, 2, 3].forEach(() => expect(editor.redo()).toBe(true))
      expect(names()).toEqual(['Intro #2'])
      expect(projectOf(doc).patterns[0].notes.map(({ tick }) => tick)).toEqual([stepTicks])
    })
  })

  test("takes back a clip put, moved, resized, trimmed and erased, a step each; the one put goes to the trash with another client's move", () => {
    const doc = newProject()
    const { pattern } = parts(doc)
    const clips = () => projectOf(doc).clips.map(({ track, tick }) => [track, tick])
    const ownLengths = () => projectOf(doc).clips.map(({ ownLength }) => ownLength)
    editing(doc, (editor) => {
      const clip = Option.getOrThrow(editor.addClip(pattern.id, { track: Id('1'), tick: Tick(0) }))
      expect(editor.moveClip(clip, { track: Id('2'), tick: Tick(barTicks) })).toBe(true)
      expect(editor.resizeClip(clip, 3 * barTicks)).toBe(true)
      expect(editor.trimClip(clip, { tick: Tick(2 * barTicks), length: 2 * barTicks, offset: 0 })).toBe(true)
      expect(editor.eraseClips([clip])).toBe(true)
      expect(clips()).toEqual([])
      expect(editor.undo()).toBe(true)
      expect(clips()).toEqual([['2', 2 * barTicks]])
      expect(editor.undo()).toBe(true)
      expect(ownLengths()).toEqual([Option.some(3 * barTicks)])
      expect(editor.undo()).toBe(true)
      expect(ownLengths()).toEqual([Option.none()])
      expect(clips()).toEqual([['2', barTicks]])
      expect(editor.undo()).toBe(true)
      expect(clips()).toEqual([['1', 0]])
      expect(moveClip(doc, elsewhere, clip, { track: Id('5'), tick: Tick(0) })).toBe(true)
      expect(editor.undo()).toBe(true)
      expect(clips()).toEqual([])
      expect(rawMap(doc, 'clips', clip).toJSON()).toMatchObject({ track: '5', deleted: true })
      expect(editor.undo()).toBe(false)
      expect(editor.redo()).toBe(true)
      expect(clips()).toEqual([['5', 0]])
    })
  })

  test('does nothing on undo and redo while an action is open, and says so; an end called twice ends it once', () => {
    const doc = newProject()
    editing(doc, (editor, registry) => {
      const canUndo = told(registry, editor.canUndo)
      const canRedo = told(registry, editor.canRedo)
      editor.setTempo(130)
      const endFirst = editor.begin()
      const endSecond = editor.begin()
      expect(editor.undo()).toBe(false)
      endFirst()
      endFirst()
      expect(editor.undo()).toBe(false)
      expect(projectOf(doc).tempo).toBe(130)
      endSecond()
      expect(canUndo).toEqual([false, true, false, true])
      expect(editor.undo()).toBe(true)
      expect(projectOf(doc).tempo).toBe(120)
      const end = editor.begin()
      expect(editor.redo()).toBe(false)
      end()
      expect(canRedo).toEqual([false, true, false, true])
      expect(editor.redo()).toBe(true)
      expect(projectOf(doc).tempo).toBe(130)
    })
  })

  test('tells when it can undo and redo; an edit that changes nothing is no step, a new one drops what was undone', () => {
    const doc = newProject()
    const { channel } = parts(doc)
    editing(doc, (editor, registry) => {
      const canUndo = told(registry, editor.canUndo)
      const canRedo = told(registry, editor.canRedo)
      expect(editor.setMute(channel.id, false)).toBe(true)
      expect(canUndo).toEqual([false])
      editor.setMute(channel.id, true)
      editor.undo()
      expect(canUndo).toEqual([false, true, false])
      expect(canRedo).toEqual([false, true])
      editor.setTempo(130)
      expect(canUndo).toEqual([false, true, false, true])
      expect(canRedo).toEqual([false, true, false])
      expect(editor.redo()).toBe(false)
      expect(projectOf(doc).channels[0].mute).toBe(false)
    })
  })
})

describe('an edit into a map made anew, its old one missing or something else in its place', () => {
  test("a parameter: undo takes back its value and leaves the map; another client's value written there since stays", () => {
    brokenWays.forEach((breakIt) => {
      const here = newProjectWithSynth()
      const there = new Y.Doc()
      connect(here, there)
      const synth = synthOf(here)
      const instrument = rawMap(here, 'channels', synth.id, 'instrument')
      breakIt(instrument, 'params')
      editing(here, (editor) => {
        expect(editor.setChannelParam(synth.id, 'osc1.shape', 1)).toBe(true)
        expect(editor.undo()).toBe(true)
        expect(shapeOf(here)).toBe(plugins.synth.params[0].default)
        expect(instrument.get('params')).toBeInstanceOf(Y.Map)
        expect(editor.redo()).toBe(true)
        expect(shapeOf(there)).toBe(1)
        setChannelParam(there, elsewhere, synth.id, 'osc1.shape', 2)
        expect(editor.undo()).toBe(false)
        expect(shapeOf(here)).toBe(2)
        expect(shapeOf(there)).toBe(2)
      })
    })
  })

  test('the map made anew is no step of any history: broken and mended, there is nothing to take back but the edit', () => {
    const doc = newProjectWithSynth()
    const synth = synthOf(doc)
    const instrument = rawMap(doc, 'channels', synth.id, 'instrument')
    editing(doc, (editor, registry) => {
      doc.transact(() => instrument.set('params', 'broken'), elsewhere)
      expect(registry.get(editor.canUndo)).toBe(false)
      expect(editor.setChannelParam(synth.id, 'osc1.shape', 1)).toBe(true)
      expect(editor.undo()).toBe(true)
      expect(registry.get(editor.canUndo)).toBe(false)
      expect(shapeOf(doc)).toBe(plugins.synth.params[0].default)
      expect(instrument.get('params')).toBeInstanceOf(Y.Map)
    })
  })
})

test('takes back notes put one by one a step each, and notes erased in one action, such as a drag, as one step', () => {
  const doc = newProject()
  const { channel, pattern } = parts(doc)
  const keys = () => notesOf(doc).map(({ key }) => key)
  editing(doc, (editor) => {
    ;[60, 64, 67].forEach((key) =>
      editor.addNote(pattern.id, channel.id, { tick: Tick(0), key: MidiKey(key), length: stepTicks })
    )
    expect(editor.undo()).toBe(true)
    expect(keys().toSorted()).toEqual([60, 64])
    const end = editor.begin()
    notesOf(doc).forEach(({ id }) => editor.eraseNotes(pattern.id, [id]))
    end()
    expect(keys()).toEqual([])
    expect(editor.undo()).toBe(true)
    expect(keys().toSorted()).toEqual([60, 64])
  })
})

test('takes back a note moved, with the one it took the place of, and a note stretched, a step each', () => {
  const doc = newProject()
  const { channel, pattern } = parts(doc)
  const place = (key: number) => ({ tick: Tick(0), key: MidiKey(key), length: stepTicks })
  const shape = () =>
    notesOf(doc)
      .map(({ key, length }) => ({ key, length: length / stepTicks }))
      .toSorted((a, b) => a.key - b.key)
  editing(doc, (editor) => {
    editor.addNote(pattern.id, channel.id, place(60))
    editor.addNote(pattern.id, channel.id, place(64))
    const [moved] = notesOf(doc).filter(({ key }) => key === 64)
    expect(editor.moveNote(pattern.id, moved.id, place(60))).toBe(true)
    expect(editor.stretchNote(pattern.id, moved.id, 2 * stepTicks)).toBe(true)
    expect(shape()).toEqual([{ key: 60, length: 2 }])
    expect(editor.undo()).toBe(true)
    expect(shape()).toEqual([{ key: 60, length: 1 }])
    expect(editor.undo()).toBe(true)
    expect(shape()).toEqual([
      { key: 60, length: 1 },
      { key: 64, length: 1 }
    ])
  })
})
