import { execPath } from 'node:process'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { describe, expect, it, layer } from '@effect/vitest'
import { Console, DateTime, Deferred, Effect, Fiber, FileSystem, Option, Ref } from 'effect'
import { report, run, ScriptError, stagingOf, updateFromStaging } from '../src/script.ts'

/** A folder of files, each by its name holding its text. */
const folder = (path: string, files: Readonly<Record<string, string>>) =>
  FileSystem.FileSystem.use((fs) =>
    fs.makeDirectory(path).pipe(
      Effect.andThen(
        Effect.forEach(Object.entries(files), ([name, text]) => fs.writeFileString(`${path}/${name}`, text), {
          discard: true
        })
      )
    )
  )

/** Each file by its name, its text. */
const contents = (path: string) =>
  FileSystem.FileSystem.use((fs) =>
    fs.readDirectory(path).pipe(
      Effect.flatMap((names) =>
        Effect.forEach(names, (name) => fs.readFileString(`${path}/${name}`).pipe(Effect.map((text) => [name, text])))
      ),
      Effect.map(Object.fromEntries)
    )
  )

const listing = (dir: string) => FileSystem.FileSystem.use((fs) => fs.readDirectory(dir))

const info = (path: string) => FileSystem.FileSystem.use((fs) => fs.stat(path))

const nameOf = (path: string) => path.split('/').at(-1)

/** An empty folder of its own, gone after the test, with the place to update in it. */
const scratch = FileSystem.FileSystem.use((fs) => fs.makeTempDirectoryScoped({ prefix: 'escapement-script-' })).pipe(
  Effect.map((dir) => ({ dir, out: `${dir}/out` }))
)

layer(NodeServices.layer)('updating a folder from its staged one', (it) => {
  it.effect(
    'a changed file is written over, a new one added, one no longer staged removed, and nothing left beside',
    () =>
      Effect.gen(function* () {
        const { dir, out } = yield* scratch
        yield* folder(out, { kept: 'same', changed: 'old', gone: 'old' })
        yield* folder(stagingOf(out), { kept: 'same', changed: 'new', added: 'new' })
        yield* updateFromStaging(out)
        expect(yield* contents(out)).toEqual({ kept: 'same', changed: 'new', added: 'new' })
        expect(yield* listing(dir)).toEqual(['out'])
      })
  )

  it.effect('the folder stays the one a dev server watches, and a file the same keeps its time', () =>
    Effect.gen(function* () {
      const { out } = yield* scratch
      yield* folder(out, { kept: 'same', changed: 'old' })
      const fs = yield* FileSystem.FileSystem
      const long = DateTime.toDateUtc(DateTime.makeUnsafe('2026-01-01T00:00:00Z'))
      yield* Effect.forEach(['kept', 'changed'], (file) => fs.utimes(`${out}/${file}`, long, long), { discard: true })
      const before = yield* info(out)
      yield* folder(stagingOf(out), { kept: 'same', changed: 'new' })
      yield* updateFromStaging(out)
      expect((yield* info(out)).ino).toEqual(before.ino)
      expect((yield* info(`${out}/kept`)).mtime).toEqual(Option.some(long))
      expect((yield* info(`${out}/changed`)).mtime).not.toEqual(Option.some(long))
    })
  )

  it.effect('a first run puts the staged files in a new folder', () =>
    Effect.gen(function* () {
      const { dir, out } = yield* scratch
      yield* folder(stagingOf(out), { added: 'new' })
      yield* updateFromStaging(out)
      expect(yield* contents(out)).toEqual({ added: 'new' })
      expect(yield* listing(dir)).toEqual(['out'])
    })
  )

  it.effect('new files move in first, then changed ones, then those no longer staged go', () =>
    Effect.gen(function* () {
      const { out } = yield* scratch
      // In the listing's order, the changed file and the one going come before the new one.
      yield* folder(out, { aaa: 'old', changed: 'old' })
      yield* folder(stagingOf(out), { changed: 'new', zzz: 'new' })
      const fs = yield* FileSystem.FileSystem
      const done = yield* Ref.make<ReadonlyArray<string>>([])
      const told = (what: string) => Ref.update(done, (list) => [...list, what])
      const telling = FileSystem.makeNoop({
        ...fs,
        rename: (from, to) => fs.rename(from, to).pipe(Effect.andThen(told(`moved ${nameOf(to)}`))),
        remove: (path, options) => fs.remove(path, options).pipe(Effect.andThen(told(`removed ${nameOf(path)}`)))
      })
      yield* updateFromStaging(out).pipe(Effect.provideService(FileSystem.FileSystem, telling))
      expect(yield* Ref.get(done)).toEqual(['moved zzz', 'moved changed', 'removed aaa', 'removed out.new'])
    })
  )

  it.effect('interrupted among its moves, as by Ctrl+C, it makes them all first', () =>
    Effect.gen(function* () {
      const { out } = yield* scratch
      yield* folder(out, { changed: 'old', gone: 'old' })
      yield* folder(stagingOf(out), { added: 'new', changed: 'new' })
      const fs = yield* FileSystem.FileSystem
      const [moving, gate] = yield* Effect.all([Deferred.make<void>(), Deferred.make<void>()])
      // Each move waits at the gate, the first one saying it has begun.
      const held = FileSystem.makeNoop({
        ...fs,
        rename: (from, to) =>
          Deferred.succeed(moving, undefined).pipe(
            Effect.andThen(Deferred.await(gate)),
            Effect.andThen(fs.rename(from, to))
          )
      })
      const updating = yield* updateFromStaging(out).pipe(
        Effect.provideService(FileSystem.FileSystem, held),
        Effect.forkChild
      )
      yield* Deferred.await(moving)
      const interrupting = yield* Effect.forkChild(Fiber.interrupt(updating))
      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(interrupting)
      expect(yield* contents(out)).toEqual({ added: 'new', changed: 'new' })
    })
  )

  it.effect('a folder among the staged files fails it before any change', () =>
    Effect.gen(function* () {
      const { out } = yield* scratch
      yield* folder(out, { changed: 'old' })
      yield* folder(stagingOf(out), { changed: 'new' })
      yield* folder(`${stagingOf(out)}/nested`, { inside: 'new' })
      const error = yield* Effect.flip(updateFromStaging(out))
      expect(error.message).toBe(`${stagingOf(out)}/nested isn't a file: only files are moved`)
      expect(yield* contents(out)).toEqual({ changed: 'old' })
    })
  )

  it.effect('a name changed only in case fails it before any change, as a disk blind to case would lose the file', () =>
    Effect.gen(function* () {
      const { out } = yield* scratch
      yield* folder(out, { Kick: 'old', changed: 'old' })
      yield* folder(stagingOf(out), { kick: 'new', changed: 'new' })
      const error = yield* Effect.flip(updateFromStaging(out))
      expect(error.message).toBe(`Only the case of a name changed: remove ${out}/Kick by hand, then run again`)
      expect(yield* contents(out)).toEqual({ Kick: 'old', changed: 'old' })
    })
  )

  it.effect('with nothing staged, it fails and the folder stays as it was', () =>
    Effect.gen(function* () {
      const { dir, out } = yield* scratch
      yield* folder(out, { kept: 'old' })
      const error = yield* Effect.flip(updateFromStaging(out))
      expect(error.message).toContain(`Listing ${stagingOf(out)}: NotFound`)
      expect(yield* contents(out)).toEqual({ kept: 'old' })
      expect(yield* listing(dir)).toEqual(['out'])
    })
  )
})

layer(NodeServices.layer)('running a program', (it) => {
  it.effect('gives what it printed, trimmed', () =>
    Effect.gen(function* () {
      expect(yield* run(execPath, ['-e', 'console.log("  printed  ")'])).toBe('printed')
    })
  )

  it.effect('fails with its exit code and what it printed to stderr', () =>
    Effect.gen(function* () {
      const script = 'console.error("broken"); process.exit(3)'
      const error = yield* Effect.flip(run(execPath, ['-e', script]))
      expect(error.message).toBe(`${execPath} -e ${script} exited with 3: broken`)
    })
  )

  it.effect('killed, fails with the signal and what it printed to stderr', () =>
    Effect.gen(function* () {
      const script = 'process.stderr.write("dying", () => process.kill(process.pid, "SIGKILL"))'
      const error = yield* Effect.flip(run(execPath, ['-e', script]))
      expect(error.message).toContain('SIGKILL')
      expect(error.message).toMatch(/: dying$/)
    })
  )

  it.effect('fails with why it didn’t start', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(run('escapement-no-such-program', ['--version']))
      expect(error.message).toMatch(/^escapement-no-such-program --version: NotFound/)
    })
  )
})

/** A console that keeps what is printed to stderr. */
const errorConsole = () => {
  const lines: string[] = []
  const console_: Console.Console = Object.assign(Object.create(globalThis.console), {
    error: (...args: ReadonlyArray<unknown>) => lines.push(args.join(' '))
  })
  return { lines, console: console_ }
}

describe('reporting how a script ended', () => {
  /** What a script that ends so prints to stderr. */
  const printedBy = (main: Effect.Effect<void, ScriptError>) =>
    Effect.gen(function* () {
      const { lines, console } = errorConsole()
      yield* main.pipe(Effect.tapCause(report), Effect.exit, Effect.provideService(Console.Console, console))
      return lines
    })

  const broken = Effect.fail(new ScriptError({ message: 'Writing x: broken' }))

  it.effect('a failure prints its message alone', () =>
    Effect.gen(function* () {
      expect(yield* printedBy(broken)).toEqual(['Writing x: broken'])
    })
  )

  it.effect('a defect in the cleanup after a failure prints with its trace, beside the failure', () =>
    Effect.gen(function* () {
      const lines = yield* printedBy(broken.pipe(Effect.ensuring(Effect.die(new Error('the cleanup broke')))))
      expect(lines).toHaveLength(2)
      expect(lines[0]).toBe('Writing x: broken')
      expect(lines[1]).toMatch(/^Error: the cleanup broke\n\s+at /)
    })
  )

  it.effect('an interrupted script prints nothing', () =>
    Effect.gen(function* () {
      expect(yield* printedBy(Effect.interrupt)).toEqual([])
    })
  )
})
