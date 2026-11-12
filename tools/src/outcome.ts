/** What a run of cargo-mutants comes to, by its exit code and its report. */
import { Console, Effect, FileSystem, Match, String } from 'effect'
import { exitedWell, ScriptError, step } from './script.ts'

const fail = (message: string) => Effect.fail(new ScriptError({ message }))

/**
 * `what` is the run, for a code with no message of its own, and `report` the `mutants.out` it wrote. A mutant that hangs
 * the tests is caught by the timeout, but cargo-mutants' code for one outranks a survivor's, so after one the list of
 * survivors decides.
 */
export const outcome = (code: number, { what, report }: { readonly what: string; readonly report: string }) => {
  const missed = `${report}/missed.txt`
  const survived = () => fail(`Mutants survived: ${missed} lists them`)
  const hung = FileSystem.FileSystem.use((fs) => fs.readFileString(missed)).pipe(
    step(`Reading ${missed}`),
    Effect.filterOrElse((list) => String.isEmpty(list.trim()), survived),
    Effect.andThen(Console.log(`Mutants that hang the tests count as caught: ${report}/timeout.txt lists them`))
  )
  return Match.value(code).pipe(
    Match.when(0, () => Effect.void),
    Match.when(2, survived),
    Match.when(3, () => hung),
    Match.when(4, () => fail('The tests fail without mutants, so they judge none')),
    Match.when(5, () => fail('The Rust changed while the tests ran: run again')),
    Match.orElse(() => Effect.succeed(code).pipe(exitedWell(what), Effect.asVoid))
  )
}
