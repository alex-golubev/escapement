/**
 * Mutation tests of the Rust changed since the branch left `main`, committed or not: cargo-mutants breaks each changed
 * line in turn, and a test should fail. Arguments go on to cargo-mutants, but for `--in-diff` and `--output`, which are
 * set here; `--jobs` there overrides the jobs here.
 */
import { arch, argv, env, platform } from 'node:process'
import { Boolean, Console, Effect } from 'effect'
import { changedRust } from './changes.ts'
import { outcome } from './outcome.ts'
import { commandLine, exists, exitCodeInTerminal, root, runInTerminal, runScript } from './script.ts'

// Another version makes other mutants, so runs compare only within one.
const version = '27.1.0'
// Keyed by platform too: node_modules may be shared with a container.
const folder = `${root}node_modules/.cache/cargo-mutants/${version}-${platform}-${arch}`
const cargoMutants = `${folder}/bin/cargo-mutants`
// The timeout in `.cargo/mutants.toml` is measured under 4.
const jobs = env.CARGO_MUTANTS_JOBS ?? '4'

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
  // The report where `outcome` reads it, whatever the environment or the config say.
  const args = ['mutants', '--in-diff', patch, '--output', root, ...argv.slice(2)]
  const code = yield* exitCodeInTerminal(cargoMutants, args, { env: { CARGO_MUTANTS_JOBS: jobs } })
  yield* outcome(code, { what: commandLine(cargoMutants, args), report: `${root}mutants.out` })
}).pipe(Effect.scoped)

runScript(main)
