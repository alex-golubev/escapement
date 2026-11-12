/** How many mutants are tested at once, and how long the tests may take with one of them. */
import { Duration, Effect } from 'effect'
import { ScriptError } from './script.ts'

/** `CARGO_MUTANTS_JOBS`, or 4 when it isn't set. */
export const jobsOf = (text: string | undefined) =>
  Effect.succeed(Number(text ?? '4')).pipe(
    Effect.filterOrFail(
      (jobs) => Number.isInteger(jobs) && jobs > 0,
      () => new ScriptError({ message: `CARGO_MUTANTS_JOBS is '${text}': it takes a whole number above 0` })
    )
  )

/** cargo-mutants' own minimum timeout, in seconds, as of the version `mutants.ts` pins. */
const floor = 20

/**
 * The timeout of one run of the tests, in whole seconds, from how long they take alone. Mutants tested at once share
 * the cores, so each run takes at most as many times as long; the timeout is twice that, and no less than
 * cargo-mutants' own floor: a short run is mostly starting up, which comes and goes. A mutant that survives runs all
 * the tests: cut short, it would count as caught.
 */
export const testTimeout = (alone: Duration.Duration, jobs: number) =>
  Math.max(floor, Math.ceil(Duration.toSeconds(alone) * jobs * 2))
