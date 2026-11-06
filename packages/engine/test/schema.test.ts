/// <reference types="vite/client" />
import { expect, it } from '@effect/vitest'
import { fingerprintOf } from '@escapement/tools/hash'
import { Effect } from 'effect'
import { Digest } from 'effect/crypto'
import schema from '../../../schema/engine.fbs?raw'
import { schemaFingerprint } from '../src/schema/fingerprint'

it.effect('the generated code is up to date with the schema', () =>
  fingerprintOf(schema).pipe(
    Effect.map((fingerprint) =>
      expect(schemaFingerprint, 'run `pnpm gen` after changing the schema').toBe(fingerprint)
    ),
    Effect.provide(Digest.layerWebCrypto)
  )
)
