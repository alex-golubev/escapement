/**
 * Generates Rust and TypeScript from `schema/engine.fbs`, and TypeScript from the plugin catalog in Rust. The output
 * is committed, so builds don't need flatc.
 */
import { arch, platform } from 'node:process'
import { Array, Boolean, Console, Effect, FileSystem, Option, Schema } from 'effect'
import { HttpClient, HttpClientResponse } from 'effect/http'
import { unzipSync } from 'fflate'
import { fingerprintOf, sha256Hex } from './hash.ts'
import {
  biomeFormat,
  decode,
  exists,
  freshStaging,
  removeStaging,
  root,
  run,
  runScript,
  ScriptError,
  type ScriptServices,
  stagingOf,
  step,
  updateFromStaging
} from './script.ts'

const schema = `${root}schema/engine.fbs`

// flatc ships only as release binaries, so it is downloaded at a pinned version. The generated code needs exactly
// these runtimes: bump all three together.
const versions = {
  flatc: '25.12.19',
  crate: '25.12.19',
  /** Published late: 25.12.19 never reached npm. */
  npm: '25.9.23'
}

interface FlatcBuild {
  readonly archive: string
  readonly sha256: string
  /** In the archive. */
  readonly binary: string
}

// Universal: Apple Silicon and Intel.
const mac: FlatcBuild = {
  archive: 'Mac.flatc.binary.zip',
  sha256: '9340a5f9900b95e34ccadcb06bceec91180cc8b83098d5e966ed6d8d590cbba2',
  binary: 'flatc'
}

const flatcBuilds: Partial<Record<string, FlatcBuild>> = {
  'darwin-arm64': mac,
  'darwin-x64': mac,
  'linux-x64': {
    archive: 'Linux.flatc.binary.g++-13.zip',
    sha256: '9f87066dc5dfa7fe02090b55bab5f3e55df03e32c9b0cdf229004ade7d091039',
    binary: 'flatc'
  },
  'win32-x64': {
    archive: 'Windows.flatc.binary.zip',
    sha256: 'fff9445c9db907227bc64b54cc98743084c4949282aa4e576cff6a955724ddc8',
    binary: 'flatc.exe'
  }
}

const platformKey = `${platform}-${arch}`
// Keyed by platform too: node_modules may be shared with a container.
const flatcFolder = `${root}node_modules/.cache/flatc/${versions.flatc}-${platformKey}`
const flatcPathOf = (build: FlatcBuild) => `${flatcFolder}/${build.binary}`

const PackageJson = Schema.fromJsonString(Schema.Struct({ dependencies: Schema.Record(Schema.String, Schema.String) }))

/** The versions the project uses. */
const runtimeVersions = Effect.gen(function* () {
  // Prints e.g. `…#flatbuffers@25.12.19`.
  const pkgid = yield* run('cargo', ['pkgid', 'flatbuffers'])
  const manifestPath = 'packages/engine/package.json'
  const fs = yield* FileSystem.FileSystem
  const manifest = yield* fs.readFileString(`${root}${manifestPath}`).pipe(step(`Reading ${manifestPath}`))
  const { dependencies } = yield* decode(PackageJson, manifestPath, manifest)
  return { crate: pkgid.slice(pkgid.lastIndexOf('@') + 1), npm: dependencies.flatbuffers }
})

const checkRuntimes = runtimeVersions.pipe(
  Effect.filterOrFail(
    ({ crate, npm }) => crate === versions.crate && npm === versions.npm,
    ({ crate, npm }) =>
      new ScriptError({
        message:
          `flatc ${versions.flatc} needs the flatbuffers crate ${versions.crate} and npm package ${versions.npm}, ` +
          `the project has ${crate} and ${npm}`
      })
  )
)

const download = (url: string) =>
  HttpClient.get(url).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((response) => response.arrayBuffer),
    Effect.map((buffer) => new Uint8Array(buffer)),
    Effect.mapError((error) => new ScriptError({ message: `Downloading ${url}: ${error.message}` }))
  )

/** Checks the archive against the pinned hash. */
const installFlatc = Effect.fn('installFlatc')(function* (build: FlatcBuild) {
  const url = `https://github.com/google/flatbuffers/releases/download/v${versions.flatc}/${encodeURIComponent(build.archive)}`
  yield* Console.log(`Downloading flatc ${versions.flatc}`)
  const archive = yield* download(url)
  yield* sha256Hex(archive).pipe(
    Effect.filterOrFail(
      (sha256) => sha256 === build.sha256,
      (sha256) => new ScriptError({ message: `${build.archive} has sha256 ${sha256}, expected ${build.sha256}` })
    )
  )
  const files = unzipSync(archive, { filter: (file) => file.name === build.binary })
  const binary = yield* Effect.fromOption(
    Option.fromNullishOr(files[build.binary]),
    () => new ScriptError({ message: `${build.archive} has no ${build.binary}` })
  )
  // A temporary name, so an interrupted run doesn't leave a broken binary.
  const path = flatcPathOf(build)
  const partial = `${path}.partial`
  const fs = yield* FileSystem.FileSystem
  yield* Effect.all([
    fs.makeDirectory(flatcFolder, { recursive: true }),
    fs.writeFile(partial, binary, { mode: 0o755 }),
    fs.rename(partial, path)
  ]).pipe(step(`Saving ${path}`))
})

const flatc = Effect.gen(function* () {
  const build = yield* Effect.fromOption(
    Option.fromNullishOr(flatcBuilds[platformKey]),
    () => new ScriptError({ message: `flatc ${versions.flatc} has no build for ${platformKey}` })
  )
  const path = flatcPathOf(build)
  yield* installFlatc(build).pipe(Effect.when(exists(path).pipe(Effect.map(Boolean.not))))
  return path
})

const Params = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    label: Schema.String,
    /** The controls it stands with, such as an oscillator's; none for a parameter on its own. */
    group: Schema.NullOr(Schema.String),
    unit: Schema.NullOr(Schema.String),
    scale: Schema.String,
    /** In the order projects keep them, by place; none for a number. */
    choices: Schema.NullOr(Schema.Array(Schema.Struct({ id: Schema.String, label: Schema.String }))),
    whole: Schema.Boolean,
    min: Schema.Finite,
    max: Schema.Finite,
    default: Schema.Finite,
    smoothingSeconds: Schema.Finite
  })
)

/** As the Rust program `describe-plugins` prints it. */
const Catalog = Schema.fromJsonString(
  Schema.Struct({
    fingerprint: Schema.Int,
    /** Every one there is, used or not. */
    units: Schema.Array(Schema.String),
    scales: Schema.Array(Schema.String),
    plugins: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        id: Schema.Int,
        version: Schema.Int,
        label: Schema.String,
        params: Params,
        samples: Schema.Array(Schema.Struct({ id: Schema.String, label: Schema.String }))
      })
    ),
    strip: Params,
    silence: Schema.Finite
  })
)

type Catalog = typeof Catalog.Type

/** As TypeScript names things: `low_pass` is `lowPass`. */
const camelCase = (name: string) => name.replace(/_(\w)/g, (_, letter: string) => letter.toUpperCase())

/** Names that would clash or not be names once converted would lose a plugin from the generated code. */
const checkNames = ({ plugins }: Catalog) => {
  const names = plugins.map(({ name }) => camelCase(name))
  return Option.match(
    Array.findFirst(names, (name, index) => !/^[a-z][A-Za-z0-9]*$/.test(name) || names.indexOf(name) !== index),
    {
      onNone: () => Effect.void,
      onSome: (bad) =>
        Effect.fail(
          new ScriptError({ message: `describe-plugins: the plugin name ${bad} is taken twice or isn't a name` })
        )
    }
  )
}

const catalog = run('cargo', ['run', '--quiet', '--package', 'describe-plugins']).pipe(
  // A field this side doesn't know fails rather than going missing.
  Effect.flatMap((json) => decode(Catalog, 'describe-plugins', json, { onExcessProperty: 'error' })),
  Effect.tap(checkNames)
)

/** What the targets are generated from. */
interface Inputs {
  readonly flatc: string
  /** The schema's. */
  readonly fingerprint: number
  readonly catalog: Catalog
}

interface GeneratedFile {
  readonly name: string
  readonly source: string
}

interface Target {
  /** Updated on every run: a file changed, added or removed only where the output differs. */
  readonly out: string
  /** Formats in place; the generated files are appended. */
  readonly formatter: () => readonly [string, ...ReadonlyArray<string>]
  /** Into the staging folder, whose files then take their places in `out`. */
  readonly write: (dir: string, inputs: Inputs) => Effect.Effect<void, ScriptError, ScriptServices>
}

const generatedNote = '// Generated by `pnpm gen`, do not modify.'

const hex = (number: number) => `0x${number.toString(16).padStart(8, '0')}`

const writeFiles = (dir: string, files: ReadonlyArray<GeneratedFile>) =>
  FileSystem.FileSystem.use((fs) =>
    Effect.forEach(
      files,
      ({ name, source }) => fs.writeFileString(`${dir}/${name}`, source).pipe(step(`Writing ${name}`)),
      {
        discard: true
      }
    )
  )

const fingerprintDoc = 'First 32 bits of the SHA-256 of `schema/engine.fbs`; the page and the engine must match.'

/** flatc's code for the schema, and the schema's fingerprint. */
const schemaTarget = (
  out: string,
  flags: ReadonlyArray<string>,
  formatter: Target['formatter'],
  fingerprint: (hex: string) => GeneratedFile
): Target => ({
  out,
  formatter,
  write: (dir, inputs) =>
    run(inputs.flatc, [...flags, '-o', dir, schema]).pipe(
      Effect.andThen(writeFiles(dir, [fingerprint(hex(inputs.fingerprint))]))
    )
})

const descriptions = ({ fingerprint, units, scales, plugins, strip, silence }: Catalog): GeneratedFile => {
  const byName = Object.fromEntries(plugins.map(({ name, ...plugin }) => [camelCase(name), plugin]))
  return {
    name: 'descriptions.ts',
    source: `${generatedNote}

/**
 * Every built-in plugin, by the name code calls it. Commands number a parameter by its place in \`params\`, from 1, and
 * edits a sample by its place in \`samples\`.
 */
export const plugins = ${JSON.stringify(byName)} as const

/** Every node's volume and pan, the engine's own: commands number them by their place here, from 1. */
export const strip = ${JSON.stringify(strip)} as const

/** Every unit a parameter can have, used or not. */
export const units = ${JSON.stringify(units)} as const

/** Every scale a parameter can have, used or not. */
export const scales = ${JSON.stringify(scales)} as const

/** The engine takes a smaller value as 0: far below hearing, and no denormal reaches a sample. */
export const silenceBelow = ${JSON.stringify(silence)}

/** The engine computes it from its own catalog and strip; the page and the engine must match. */
export const descriptionsFingerprint = ${hex(fingerprint)}
`
  }
}

const targets: ReadonlyArray<Target> = [
  schemaTarget(
    'crates/engine-core/src/schema',
    ['--rust'],
    // Standalone rustfmt defaults to the 2015 edition; this is the workspace's.
    () => ['rustfmt', '--edition', '2024'],
    (hex) => ({
      name: 'fingerprint.rs',
      source: `${generatedNote}\n\n/// ${fingerprintDoc}\npub const SCHEMA_FINGERPRINT: u32 = ${hex};\n`
    })
  ),
  schemaTarget(
    'packages/engine/src/schema',
    // Imports without extensions, like the rest of the code; the option isn't in `flatc --help`.
    ['--ts', '--ts-no-import-ext'],
    biomeFormat,
    (hex) => ({
      name: 'fingerprint.ts',
      source: `${generatedNote}\n\n/** ${fingerprintDoc} */\nexport const schemaFingerprint = ${hex}\n`
    })
  ),
  {
    out: 'packages/engine-description/src/catalog',
    formatter: biomeFormat,
    write: (dir, { catalog }) => writeFiles(dir, [descriptions(catalog)])
  }
]

// Generated next to the target first, so an error in generating or formatting leaves the current code in place.
const outOf = (target: Target) => `${root}${target.out}`

const format = Effect.fn('format')(function* (target: Target) {
  const [command, ...args] = target.formatter()
  const staging = stagingOf(outOf(target))
  const fs = yield* FileSystem.FileSystem
  const files = yield* fs.readDirectory(staging).pipe(step(`Listing ${staging}`))
  yield* run(command, [...args, ...files.map((file) => `${staging}/${file}`)])
})

const generate = Effect.fn('generate')(function* (inputs: Inputs, target: Target) {
  yield* freshStaging(outOf(target))
  yield* target.write(stagingOf(outOf(target)), inputs)
  yield* format(target)
})

const update = (target: Target) =>
  updateFromStaging(outOf(target)).pipe(Effect.andThen(Console.log(`Generated ${target.out}`)))

const main = Effect.gen(function* () {
  yield* checkRuntimes
  const inputs: Inputs = yield* Effect.all(
    {
      flatc,
      fingerprint: FileSystem.FileSystem.use((fs) => fs.readFileString(schema)).pipe(
        step(`Reading ${schema}`),
        Effect.flatMap(fingerprintOf)
      ),
      catalog
    },
    { concurrency: 'unbounded' }
  )
  yield* Effect.forEach(targets, (target) => generate(inputs, target), { discard: true })
  yield* Effect.forEach(targets, update, { discard: true })
}).pipe(
  Effect.ensuring(
    Effect.forEach(targets, (target) => removeStaging(outOf(target)), { discard: true }).pipe(Effect.orDie)
  )
)

runScript(main)
