import * as NodeServices from '@effect/platform-node/NodeServices'
import { expect, it } from '@effect/vitest'
import { Effect, FileSystem, Schema } from 'effect'
import { decode, root, run } from '../src/script.ts'

const RootPackage = Schema.fromJsonString(
  Schema.Struct({ devDependencies: Schema.Struct({ typescript: Schema.String, '@effect/tsgo': Schema.String }) })
)

// Without the patch `prepare` puts in on install, tsc passes code that breaks Effect's rules.
it.effect("the workspace's tsc is the pinned TypeScript, patched with the pinned Effect rules", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const text = yield* fs.readFileString(`${root}package.json`)
    const { devDependencies } = yield* decode(RootPackage, 'package.json', text)
    const version = yield* run(`${root}node_modules/.bin/tsc`, ['--version'])
    expect(version).toBe(`Version ${devDependencies.typescript}+effect-tsgo.${devDependencies['@effect/tsgo']}`)
  }).pipe(Effect.provide(NodeServices.layer))
)
