import * as NodeServices from '@effect/platform-node/NodeServices'
import { expect, layer } from '@effect/vitest'
import { Array, Effect, FileSystem, Layer, Option, Schema } from 'effect'
import { Digest } from 'effect/crypto'
import { sha256Hex } from '../src/hash.ts'
import { SampleManifest } from '../src/sample-manifest.ts'
import { decode, root } from '../src/script.ts'
import { type Recipe, recipes, sampleFile, wavSeconds } from '../src/sounds.ts'

const folder = `${root}samples`

const manifest = FileSystem.FileSystem.use((fs) => fs.readFileString(`${folder}/manifest.json`)).pipe(
  Effect.flatMap((text) =>
    decode(Schema.fromJsonString(SampleManifest), 'manifest.json', text, { onExcessProperty: 'error' })
  )
)

const sampleOf = (recipe: Recipe) =>
  manifest.pipe(
    Effect.map(({ samples }) =>
      Option.getOrThrowWith(
        Array.findFirst(samples, (sample) => sample.recipe === recipe.id),
        () => new Error(`The manifest has no sample from the ${recipe.id} recipe`)
      )
    )
  )

const bytesOf = (file: string) => FileSystem.FileSystem.use((fs) => fs.readFile(`${folder}/${file}`))

layer(Layer.mergeAll(NodeServices.layer, Digest.layerWebCrypto))('the samples', (it) => {
  it.effect('the folder holds the manifest and exactly the samples it lists, one for each recipe', () =>
    Effect.gen(function* () {
      const { samples } = yield* manifest
      const fs = yield* FileSystem.FileSystem
      // Hidden files are the system's own, such as Finder's .DS_Store.
      const present = (yield* fs.readDirectory(folder)).filter((name) => !name.startsWith('.'))
      expect(present.sort()).toEqual([...samples.map(({ file }) => file), 'manifest.json'].sort())
      expect(samples.map(({ recipe }) => recipe)).toEqual(recipes.map(({ id }) => id))
    })
  )

  it.effect('the manifest lists each sound once', () =>
    Effect.gen(function* () {
      const { samples } = yield* manifest
      const first = Option.getOrThrowWith(Array.head(samples), () => new Error('The manifest has no samples'))
      const twice = { samples: [first, { ...first, name: 'Again', file: 'again.wav' }] }
      const error = yield* Effect.flip(Schema.decodeEffect(SampleManifest)(twice))
      expect(error.message).toContain('again.wav is the same sound as a sample before it')
    })
  )

  it.effect.each(recipes)('the $id sample has the hash and length the manifest gives', (recipe) =>
    Effect.gen(function* () {
      const { file, sha256, seconds } = yield* sampleOf(recipe)
      const bytes = yield* bytesOf(file)
      expect(yield* sha256Hex(bytes), `${file} isn't what the manifest says: restore it from git`).toBe(sha256)
      expect(wavSeconds(bytes)).toBe(seconds)
    })
  )

  it.effect.each(recipes)('the $id recipe still makes the committed file', (recipe) =>
    Effect.gen(function* () {
      const { file, sha256 } = yield* sampleOf(recipe)
      const fix = 'undo the change, or run `pnpm samples` to give the sound a new hash'
      expect(yield* sha256Hex(sampleFile(recipe)), `the ${recipe.id} recipe no longer makes ${file}: ${fix}`).toBe(
        sha256
      )
    })
  )
})
