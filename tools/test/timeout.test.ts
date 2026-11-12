import { expect, it } from '@effect/vitest'
import { Duration, Effect } from 'effect'
import { jobsOf, testTimeout } from '../src/timeout.ts'

it('a run of the tests may take twice as long as alone times the mutants tested at once, in whole seconds', () => {
  expect(testTimeout(Duration.seconds(22), 4)).toBe(176)
  expect(testTimeout(Duration.seconds(22), 1)).toBe(44)
  expect(testTimeout(Duration.millis(21_801), 4)).toBe(175)
})

it.effect('the mutants tested at once are 4 unless set, and only a whole number above 0', () =>
  Effect.gen(function* () {
    expect(yield* jobsOf(undefined)).toBe(4)
    expect(yield* jobsOf('8')).toBe(8)
    const refused = (text: string) =>
      jobsOf(text).pipe(
        Effect.flip,
        Effect.map((error) => error.message)
      )
    expect(yield* refused('')).toBe("CARGO_MUTANTS_JOBS is '': it takes a whole number above 0")
    expect(yield* refused('0')).toBe("CARGO_MUTANTS_JOBS is '0': it takes a whole number above 0")
    expect(yield* refused('2.5')).toBe("CARGO_MUTANTS_JOBS is '2.5': it takes a whole number above 0")
    expect(yield* refused('many')).toBe("CARGO_MUTANTS_JOBS is 'many': it takes a whole number above 0")
  })
)
