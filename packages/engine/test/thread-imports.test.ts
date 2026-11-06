import { expect, it } from '@effect/vitest'
import { Boolean, Effect } from 'effect'
import { build, type Plugin } from 'vite'

const engine = `${import.meta.dirname}/..`

/**
 * The packages a thread's code loads, through our own modules and our own packages, as Vite resolves them with no
 * options of the page's; imports of types only are erased before.
 */
const packagesOf = (entry: string) => {
  const packages = new Set<string>()
  const recorder: Plugin = {
    name: 'record-packages',
    // Vite's own resolver would answer first.
    enforce: 'pre',
    resolveId: (source, importer) => {
      const bare = !source.startsWith('.') && !source.startsWith('/') && !source.startsWith('\0')
      // A package from outside the workspace is not followed in.
      Boolean.match(bare && importer !== undefined && !importer.includes('/node_modules/'), {
        onTrue: () => void packages.add(source),
        onFalse: () => {}
      })
      return null
    }
  }
  return Effect.promise(() =>
    build({
      root: engine,
      configFile: false,
      logLevel: 'silent',
      plugins: [recorder],
      build: { write: false, rolldownOptions: { input: entry } }
    })
  ).pipe(Effect.map(() => [...packages].sort()))
}

// The threads start with nothing of the page's, Effect included: each package here is a choice.
it.effect.each([
  ['src/build-thread/worker.ts', ['@escapement/engine-description/contract', 'flatbuffers']],
  ['src/worklet/processor.ts', ['ringbuf.js']]
] as const)('%s loads no package but %j', ([entry, packages]) =>
  Effect.gen(function* () {
    expect(yield* packagesOf(entry)).toEqual(packages)
  })
)
