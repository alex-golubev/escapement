/** What every script here needs: the repository's root, running programs, and failures that print as a message. */
import { createRequire } from 'node:module'
import { execPath } from 'node:process'
import { fileURLToPath } from 'node:url'
// The package's root would load its Redis and HTTP modules too.
import * as NodeRuntime from '@effect/platform-node/NodeRuntime'
import * as NodeServices from '@effect/platform-node/NodeServices'
import {
  Array,
  Cause,
  Console,
  Data,
  Effect,
  FileSystem,
  Layer,
  Match,
  type PlatformError,
  Schema,
  Stream,
  String
} from 'effect'
import { Digest } from 'effect/crypto'
import { FetchHttpClient } from 'effect/http'
import { ChildProcess } from 'effect/process'

export const root = fileURLToPath(new URL('../../', import.meta.url))

/**
 * Found when called, so importing this module needs nothing installed. Biome's launcher picks the platform's binary.
 */
export const biomeFormat = (): readonly [string, ...ReadonlyArray<string>] => [
  execPath,
  createRequire(`${root}package.json`).resolve('@biomejs/biome/bin/biome'),
  'format',
  '--write'
]

export class ScriptError extends Data.TaggedError('ScriptError')<{ readonly message: string }> {}

/** A failure of the platform, as the step it broke. */
export const step =
  (what: string) =>
  <A, R>(effect: Effect.Effect<A, PlatformError.PlatformError, R>) =>
    effect.pipe(Effect.mapError((error) => new ScriptError({ message: `${what}: ${error.message}` })))

const text = (stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>) =>
  stream.pipe(Stream.decodeText, Stream.mkString)

/** The parts that aren't empty, as one message. */
const joined = (...parts: ReadonlyArray<string>) => Array.filter(parts, String.isNonEmpty).join(': ')

/** Interrupting it stops the program too. A program that fails fails with what it printed to stderr. */
export const run = (file: string, args: ReadonlyArray<string>) => {
  const what = `${file} ${args.join(' ')}`
  return Effect.gen(function* () {
    // In the terminal's process group, as from a shell: Ctrl+C and a closed terminal reach it too.
    const program = yield* ChildProcess.make(file, args, { cwd: root, detached: false, forceKillAfter: '3 seconds' })
    return yield* Effect.all(
      { stdout: text(program.stdout), stderr: text(program.stderr), ended: Effect.exit(program.exitCode) },
      { concurrency: 'unbounded' }
    )
  }).pipe(
    Effect.scoped,
    step(what),
    Effect.flatMap(({ stdout, stderr, ended }) =>
      ended.pipe(
        step(what),
        Effect.filterOrFail(
          (code) => code === 0,
          (code) => new ScriptError({ message: `${what} exited with ${code}` })
        ),
        Effect.mapError((error) => new ScriptError({ message: joined(error.message, stderr.trim()) })),
        Effect.as(stdout.trim())
      )
    )
  )
}

export const decode = <S extends Schema.Top>(
  schema: S,
  what: string,
  input: unknown,
  options?: { readonly onExcessProperty: 'error' }
) =>
  Schema.decodeUnknownEffect(schema)(input, options).pipe(
    Effect.mapError((error) => new ScriptError({ message: `${what}: ${error.message}` }))
  )

export const exists = (path: string) =>
  FileSystem.FileSystem.use((fs) => fs.exists(path)).pipe(step(`Looking for ${path}`))

const removeFolder = (path: string) =>
  FileSystem.FileSystem.use((fs) => fs.remove(path, { recursive: true, force: true })).pipe(step(`Removing ${path}`))

const rename = (what: string, from: string, to: string) =>
  FileSystem.FileSystem.use((fs) => fs.rename(from, to)).pipe(step(what))

/** Where a folder is built before its files take their places in `out`, so a failure leaves `out` as it is. */
export const stagingOf = (out: string) => `${out}.new`

export const freshStaging = (out: string) =>
  removeFolder(stagingOf(out)).pipe(
    Effect.andThen(
      FileSystem.FileSystem.use((fs) => fs.makeDirectory(stagingOf(out), { recursive: true })).pipe(
        step(`Creating ${stagingOf(out)}`)
      )
    )
  )

export const removeStaging = (out: string) => removeFolder(stagingOf(out))

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, at) => byte === b[at])

/** A folder's files, failing on anything else in it: only files are moved. */
const filesIn = (folder: string) =>
  FileSystem.FileSystem.use((fs) =>
    fs.readDirectory(folder).pipe(
      step(`Listing ${folder}`),
      Effect.tap((names) =>
        Effect.forEach(names, (name) =>
          fs.stat(`${folder}/${name}`).pipe(
            step(`Looking at ${folder}/${name}`),
            Effect.filterOrFail(
              ({ type }) => type === 'File',
              () => new ScriptError({ message: `${folder}/${name} isn't a file: only files are moved` })
            )
          )
        )
      )
    )
  )

/**
 * The staged folder's files take their places in `out`, and the staged folder goes: new files first, then changed
 * ones over the old, then those no longer staged go, so no file names one not there yet; one the same is left as it is.
 * `out` stays the folder it was, so a dev server watching it sees each change, where a folder put in its place it would
 * miss; a file left as it is keeps its time, so nothing is rebuilt for it. Every check comes before the first move,
 * and the moves can't be interrupted, so a failure or Ctrl+C before them leaves `out` as it was; one among them, such
 * as a file held open on Windows, can leave some files new: run again.
 */
export const updateFromStaging = Effect.fn('updateFromStaging')(function* (out: string) {
  const fs = yield* FileSystem.FileSystem
  const staging = stagingOf(out)
  const staged = yield* filesIn(staging)
  yield* fs.makeDirectory(out, { recursive: true }).pipe(step(`Creating ${out}`))
  const present = yield* filesIn(out)
  // On a disk that doesn't tell case apart, the new one would move in over the old one, then go with it.
  const twins = present.filter((file) =>
    staged.some((name) => name !== file && name.toLowerCase() === file.toLowerCase())
  )
  yield* Effect.succeed(twins).pipe(
    Effect.filterOrFail(Array.isReadonlyArrayEmpty, () => {
      const named = twins.map((file) => `${out}/${file}`).join(', ')
      return new ScriptError({ message: `Only the case of a name changed: remove ${named} by hand, then run again` })
    })
  )
  const read = (path: string) => fs.readFile(path).pipe(step(`Reading ${path}`))
  const changed = yield* Effect.filter(Array.intersection(staged, present), (file) =>
    Effect.all([read(`${staging}/${file}`), read(`${out}/${file}`)]).pipe(
      Effect.map(([now, was]) => !sameBytes(now, was))
    )
  )
  const moveIn = (file: string) => rename(`Moving ${file} into ${out}`, `${staging}/${file}`, `${out}/${file}`)
  yield* Effect.uninterruptible(
    Effect.all(
      [
        Effect.forEach(Array.difference(staged, present), moveIn, { discard: true }),
        Effect.forEach(changed, moveIn, { discard: true }),
        Effect.forEach(
          Array.difference(present, staged),
          (file) => fs.remove(`${out}/${file}`).pipe(step(`Removing ${out}/${file}`)),
          { discard: true }
        )
      ],
      { discard: true }
    )
  )
  yield* removeFolder(staging)
})

/** What the scripts run on. */
const scriptServices = Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer, Digest.layerWebCrypto)

export type ScriptServices = Layer.Success<typeof scriptServices>

/**
 * Each expected failure by its message alone, anything else with its trace. A cleanup that dies turns the failure
 * before it into a defect too.
 */
export const report = (cause: Cause.Cause<ScriptError>) =>
  Effect.forEach(
    cause.reasons,
    (reason) =>
      Match.valueTags(reason, {
        Fail: ({ error }) => Console.error(error.message),
        Die: (die) =>
          Match.value(die.defect).pipe(
            Match.when(Match.instanceOf(ScriptError), (error) => Console.error(error.message)),
            Match.orElse(() => Console.error(Cause.pretty(Cause.fromReasons([die]))))
          ),
        Interrupt: () => Effect.void
      }),
    { discard: true }
  )

/** Ctrl+C interrupts, so cleanups still run. */
export const runScript = (main: Effect.Effect<void, ScriptError, ScriptServices>) =>
  NodeRuntime.runMain(main.pipe(Effect.tapCause(report), Effect.provide(scriptServices)), {
    disableErrorReporting: true
  })
