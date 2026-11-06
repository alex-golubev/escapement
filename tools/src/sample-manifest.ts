import { Array, Option, Schema } from 'effect'

/** Where each sample came from: the files and this manifest are the truth, the recipes only made them. */
export const SampleManifest = Schema.Struct({
  samples: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      /** In `samples/`. */
      file: Schema.String,
      /** Lowercase hex: what projects and the engine refer to the sample by. */
      sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
      seconds: Schema.Finite,
      author: Schema.String,
      /** The script that made it. */
      source: Schema.String,
      recipe: Schema.String,
      license: Schema.Literal('CC0-1.0'),
      /** The day, in UTC, it took its current hash, as YYYY-MM-DD. */
      created: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/))
    })
  ).check(
    // A sample is known by its hash: two files of one sound would be one sample under two names.
    Schema.makeFilter((samples) =>
      Array.findFirst(samples, ({ sha256 }, i) => samples.findIndex((sample) => sample.sha256 === sha256) !== i).pipe(
        Option.map((again) => `${again.file} is the same sound as a sample before it`),
        Option.getOrUndefined
      )
    )
  )
})

export type SampleManifest = typeof SampleManifest.Type
