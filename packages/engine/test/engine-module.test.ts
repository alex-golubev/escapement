import { expect, test } from 'vitest'
import { moduleBytes } from './harness'

/** The source files the release build names in its panic locations: each a run of path characters up to `.rs`. */
const sources = new TextDecoder().decode(moduleBytes).match(/[\w./-]+\.rs\b/g) ?? []

test("the engine names its sources relative to the workspace or by cargo's placeholders, never where they lay when built", () => {
  expect(sources.some((source) => source.startsWith('crates/'))).toBe(true)
  expect(sources.filter((source) => !/^(crates|\/rustc|\/cargo\/registry)\//.test(source))).toEqual([])
})
