/**
 * Mutation tests of the Rust changed since the branch left `main`, committed or not: cargo-mutants breaks each changed
 * line in turn, and a test should fail. Arguments go on to cargo-mutants; `--jobs` there overrides the jobs here.
 */
import { arch, argv, env, platform } from 'node:process'
import { Boolean, Console, Effect } from 'effect'
import { changedRust } from './changes.ts'
import { exists, root, runInTerminal, runScript } from './script.ts'

// Another version makes other mutants, so runs compare only within one.
const version = '27.1.0'
// Keyed by platform too: node_modules may be shared with a container.
const folder = `${root}node_modules/.cache/cargo-mutants/${version}-${platform}-${arch}`
const cargoMutants = `${folder}/bin/cargo-mutants`
// The timeout in `.cargo/mutants.toml` is measured under 4.
const jobs = env.CARGO_MUTANTS_JOBS ?? '4'

// By cargo-mutants' exit codes; a usage error it explains itself.
const failures = {
  2: 'Mutants survived: mutants.out/missed.txt lists them',
  3: 'Mutants timed out: mutants.out/timeout.txt lists them',
  4: 'The tests fail without mutants, so they judge none'
}

const install = Console.log(`Building cargo-mutants ${version}, once for this version: it takes a minute or so`).pipe(
  Effect.andThen(
    runInTerminal('cargo', ['install', '--locked', '--quiet', '--root', folder, `cargo-mutants@${version}`])
  )
)

const main = Effect.gen(function* () {
  yield* install.pipe(Effect.when(exists(cargoMutants).pipe(Effect.map(Boolean.not))))
  const patch = yield* changedRust(root, 'origin/main')
  // Without mutants, cargo-mutants runs only the mutated packages' tests, though each mutant runs the workspace's: a
  // test failing elsewhere would catch every mutant.
  yield* runInTerminal('cargo', ['test', '--workspace', '--quiet'])
  yield* runInTerminal(cargoMutants, ['mutants', '--in-diff', patch, ...argv.slice(2)], {
    env: { CARGO_MUTANTS_JOBS: jobs },
    failures
  })
}).pipe(Effect.scoped)

runScript(main)
