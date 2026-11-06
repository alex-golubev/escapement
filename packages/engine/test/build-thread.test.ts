import { expect, test } from 'vitest'
import { checkContract } from '../src/build-thread/build-engine'
import { createEngineMemory } from '../src/memory'
import { startBuildThread } from '../src/threads'
import { module } from './harness'

const engineExports = () => startBuildThread(module, createEngineMemory())

test('the page and the engine agree on the contract', () => {
  expect(() => checkContract(engineExports())).not.toThrow()
})

test('an engine built from another schema is refused', () => {
  const exports = engineExports()
  const other = { ...exports, engine_schema_fingerprint: () => exports.engine_schema_fingerprint() ^ 1 }
  expect(() => checkContract(other)).toThrow(/engine_schema_fingerprint/)
})

test('an engine with other ticks to a quarter note, tempos, keys or velocities is refused', () => {
  const exports = engineExports()
  const constants = [
    'engine_ticks_per_quarter',
    'engine_min_tempo',
    'engine_max_tempo',
    'engine_default_tempo',
    'engine_highest_key',
    'engine_min_velocity',
    'engine_max_velocity'
  ] as const
  constants.forEach((name) => {
    const other = { ...exports, [name]: () => exports[name]() + 1 }
    expect(() => checkContract(other)).toThrow(new RegExp(`${name}\\(\\) is \\d+, this page expects \\d+`))
  })
})

test('a velocity is compared as it is, not as a whole number', () => {
  const exports = engineExports()
  const other = { ...exports, engine_max_velocity: () => exports.engine_max_velocity() + 0.5 }
  expect(() => checkContract(other)).toThrow('engine_max_velocity() is 1.5, this page expects 1')
})

test('an engine built with other plugin descriptions is refused', () => {
  const exports = engineExports()
  const other = { ...exports, engine_plugins_fingerprint: () => exports.engine_plugins_fingerprint() ^ 1 }
  expect(() => checkContract(other)).toThrow(/engine_plugins_fingerprint\(\) is 0x[0-9a-f]+, .*pnpm gen.*rebuild/)
})
