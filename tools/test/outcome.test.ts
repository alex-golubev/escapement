import * as NodeServices from '@effect/platform-node/NodeServices'
import { expect, layer } from '@effect/vitest'
import { Effect, FileSystem, Option } from 'effect'
import { outcome } from '../src/outcome.ts'

/** A report whose survivors are `missed`, or one without the list. */
const report = (missed: Option.Option<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const folder = yield* fs.makeTempDirectoryScoped({ prefix: 'escapement-outcome-' })
    yield* Option.match(missed, {
      onNone: () => Effect.void,
      onSome: (list) => fs.writeFileString(`${folder}/missed.txt`, list)
    })
    return folder
  })

/** What a run with this code and this report fails with, or 'passed'. */
const ending = (code: number, missed: Option.Option<string>) =>
  report(missed).pipe(
    Effect.flatMap((folder) =>
      outcome(code, { what: 'cargo mutants', report: folder }).pipe(
        Effect.as('passed'),
        Effect.catch((error) => Effect.succeed(error.message.replace(folder, 'report')))
      )
    ),
    Effect.scoped
  )

const noneSurvived = Option.some('')
const survivor = Option.some('crates/x.rs:1:1: replace f with ()\n')
const survived = 'Mutants survived: report/missed.txt lists them'

layer(NodeServices.layer)('what a run of cargo-mutants comes to', (it) => {
  it.effect('caught everything, it passes; with a survivor, it fails', () =>
    Effect.gen(function* () {
      expect(yield* ending(0, noneSurvived)).toBe('passed')
      expect(yield* ending(2, survivor)).toBe(survived)
    })
  )

  it.effect('a mutant that hangs the tests counts as caught, unless another survived', () =>
    Effect.gen(function* () {
      expect(yield* ending(3, noneSurvived)).toBe('passed')
      expect(yield* ending(3, survivor)).toBe(survived)
      expect(yield* ending(3, Option.none())).toMatch(/^Reading report\/missed\.txt: /)
    })
  )

  it.effect('any other code fails with what it means, or names the run', () =>
    Effect.gen(function* () {
      expect(yield* ending(4, noneSurvived)).toBe('The tests fail without mutants, so they judge none')
      expect(yield* ending(5, noneSurvived)).toBe('The Rust changed while the tests ran: run again')
      expect(yield* ending(6, noneSurvived)).toBe('cargo mutants exited with 6')
    })
  )
})
