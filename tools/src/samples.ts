/**
 * Writes the debug samples and their manifest into `samples/`. Run only to change a sound: the files are the truth,
 * and projects refer to a sample by its hash, so the output says which hashes changed.
 */
import { Array, Boolean, Console, DateTime, Effect, FileSystem, Option, Schema } from 'effect'
import { sha256Hex } from './hash.ts'
import { SampleManifest } from './sample-manifest.ts'
import {
  biomeFormat,
  decode,
  exists,
  freshStaging,
  removeStaging,
  root,
  run,
  runScript,
  stagingOf,
  step,
  updateFromStaging
} from './script.ts'
import { type Recipe, recipes, sampleFile, wavSeconds } from './sounds.ts'

const folder = `${root}samples`
const manifestName = 'manifest.json'

/** What the samples had, so an unchanged sound keeps the day it was made. */
const previous = Effect.gen(function* () {
  const path = `${folder}/${manifestName}`
  const read = FileSystem.FileSystem.use((fs) => fs.readFileString(path)).pipe(
    step(`Reading ${path}`),
    Effect.flatMap((text) => decode(Schema.fromJsonString(SampleManifest), path, text)),
    Effect.map(({ samples }) => samples)
  )
  return yield* read.pipe(Effect.when(exists(path)), Effect.map(Option.getOrElse(() => [])))
})

const fileOf = (recipe: Recipe) => `${recipe.id}.wav`

type Sample = SampleManifest['samples'][number]

const changeOf = (before: ReadonlyArray<Sample>, { file, sha256 }: Sample) =>
  Option.match(
    Array.findFirst(before, (sample) => sample.file === file),
    {
      onNone: () => 'new',
      onSome: (old) => Boolean.match(old.sha256 === sha256, { onTrue: () => 'unchanged', onFalse: () => 'new hash' })
    }
  )

const main = Effect.gen(function* () {
  const before = yield* previous
  const today = DateTime.formatIsoDateUtc(yield* DateTime.now)
  const made = yield* Effect.forEach(recipes, (recipe) =>
    Effect.gen(function* () {
      const bytes = sampleFile(recipe)
      const file = fileOf(recipe)
      const sha256 = yield* sha256Hex(bytes)
      const created = before.find((sample) => sample.file === file && sample.sha256 === sha256)?.created ?? today
      const entry = {
        name: recipe.name,
        file,
        sha256,
        seconds: wavSeconds(bytes),
        author: 'Escapement',
        source: 'tools/src/sounds.ts',
        recipe: recipe.id,
        license: 'CC0-1.0',
        created
      } as const
      return { bytes, entry }
    })
  )
  const manifest = yield* decode(SampleManifest, 'The samples made', { samples: made.map(({ entry }) => entry) })
  const staging = stagingOf(folder)
  yield* freshStaging(folder)
  const fs = yield* FileSystem.FileSystem
  yield* Effect.all(
    [
      ...made.map(({ bytes, entry }) => fs.writeFile(`${staging}/${entry.file}`, bytes)),
      fs.writeFileString(`${staging}/${manifestName}`, JSON.stringify(manifest))
    ],
    { concurrency: 'unbounded' }
  ).pipe(step(`Writing ${staging}`))
  const [command, ...args] = biomeFormat()
  yield* run(command, [...args, `${staging}/${manifestName}`])
  yield* updateFromStaging(folder)
  const changes = [
    ...made.map(({ entry }) => `${entry.file}: ${changeOf(before, entry)}`),
    ...before.filter(({ file }) => !made.some(({ entry }) => entry.file === file)).map(({ file }) => `${file}: removed`)
  ]
  yield* Effect.forEach(changes, (change) => Console.log(change), { discard: true })
}).pipe(Effect.ensuring(removeStaging(folder).pipe(Effect.orDie)))

runScript(main)
