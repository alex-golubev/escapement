/**
 * Mutation tests of the Rust changed since the branch left `main`, committed or not: cargo-mutants breaks each changed
 * line in turn, and a test should fail. `MUTANTS_BASE` names another base: CI, which checks a pull request merged onto
 * `main`, gives `HEAD^`. `CARGO_MUTANTS_JOBS` sets how many mutants are tested at once, and the timeout goes by it.
 * Arguments go on to cargo-mutants; those the timeout depends on are set here, and giving them again is an error.
 */
import { arch, argv, env, platform } from 'node:process'
import { Boolean, Console, Effect, Option, String } from 'effect'
import { changedRust } from './changes.ts'
import { outcome } from './outcome.ts'
import { commandLine, exists, exitCodeInTerminal, root, run, runInTerminal, runScript } from './script.ts'
import { jobsOf, testTimeout } from './timeout.ts'

// Another version makes other mutants, so runs compare only within one.
const version = '27.1.0'
// Keyed by platform too: node_modules may be shared with a container.
const folder = `${root}node_modules/.cache/cargo-mutants/${version}-${platform}-${arch}`
const cargoMutants = `${folder}/bin/cargo-mutants`
const base = env.MUTANTS_BASE ?? 'origin/main'

const install = Console.log(`Building cargo-mutants ${version}, once for this version: it takes a minute or so`).pipe(
  Effect.andThen(
    runInTerminal('cargo', ['install', '--locked', '--quiet', '--root', folder, `cargo-mutants@${version}`])
  )
)

/** The patch, if it changes code a mutant can be made of: not only tests, comments or what the config leaves out. */
const withMutants = Effect.fn('withMutants')(function* (patch: string) {
  yield* install.pipe(Effect.when(exists(cargoMutants).pipe(Effect.map(Boolean.not))))
  const listed = yield* run(cargoMutants, ['mutants', '--in-diff', patch, '--list'])
  return Option.liftPredicate(listed, String.isNonEmpty).pipe(Option.as(patch))
})

const mutate = Effect.fn('mutate')(function* (patch: string, jobs: number) {
  // Without mutants, cargo-mutants runs only the mutated packages' tests, though each mutant runs the workspace's: a
  // test failing elsewhere would catch every mutant, and the timeout it sets from that run would cut a quick
  // package's mutants short. So the workspace's tests run here, built first so that only they are timed.
  yield* runInTerminal('cargo', ['test', '--workspace', '--no-run', '--quiet'])
  const [alone] = yield* Effect.timed(runInTerminal('cargo', ['test', '--workspace', '--quiet']))
  // The report where `outcome` reads it, whatever the environment or the config say. Without its own baseline run
  // cargo-mutants would take no minimum timeout.
  const args = [
    'mutants',
    '--in-diff',
    patch,
    '--output',
    root,
    '--jobs',
    `${jobs}`,
    '--minimum-test-timeout',
    `${testTimeout(alone, jobs)}`,
    '--baseline',
    'run',
    ...argv.slice(2)
  ]
  const code = yield* exitCodeInTerminal(cargoMutants, args)
  yield* outcome(code, { what: commandLine(cargoMutants, args), report: `${root}mutants.out` })
})

const main = Effect.gen(function* () {
  const jobs = yield* jobsOf(env.CARGO_MUTANTS_JOBS)
  const patch = yield* changedRust(root, base).pipe(
    Effect.flatMap(Option.match({ onNone: () => Effect.succeedNone, onSome: withMutants }))
  )
  yield* Option.match(patch, {
    onNone: () => Console.log(`No Rust a mutant can be made of changed since ${base}`),
    onSome: (patch) => mutate(patch, jobs)
  })
}).pipe(Effect.scoped)

runScript(main)
