import { EngineStartError } from '@escapement/engine'
import { Data, Duration, Effect, Option } from 'effect'
import type { OutputContext, OutputEngine } from './audio-output'

export class AudioThreadHung extends Data.TaggedError('AudioThreadHung')<{ readonly message: string }> {}

export class BuildThreadHung extends Data.TaggedError('BuildThreadHung')<{ readonly message: string }> {}

/** How often a thread is looked after. */
const lookEvery = Duration.seconds(1)

/** A thread that is there answers between two blocks. */
const audioSilence = Duration.seconds(2)

/** A build takes milliseconds, and a sound is copied in parts with answers between them. */
const buildSilence = Duration.seconds(5)

/** The build thread makes the first batch before it answers its start. */
const startSilence = Duration.seconds(10)

/** Whether the audio thread answers in time. */
export const answers = (engine: OutputEngine) =>
  Effect.map(Effect.timeoutOption(engine.ping('audio'), audioSilence), Option.isSome)

/**
 * Blocks that go on are answer enough, so the thread is asked only while they stand as the context runs: a stalled
 * device stops them too, but a thread that is there answers without them. It is asked twice, since a computer that
 * wakes from sleep may run the page's timer before the answer.
 */
const audioHang = (engine: OutputEngine, context: Pick<OutputContext, 'state'>) => {
  const blocks = () => engine.readTelemetry()?.blocks
  /** A second's look: whether the blocks stood all along, and the thread didn't answer. */
  const look = Effect.gen(function* () {
    const before = blocks()
    yield* Effect.sleep(lookEvery)
    const standing = () => context.state === 'running' && blocks() === before
    return standing() && !(yield* answers(engine)) && !(yield* answers(engine)) && standing()
  })
  return look.pipe(
    Effect.repeat({ until: (hung) => hung }),
    Effect.andThen(engine.abandon),
    // Made once the hang is found, which its stack then tells of.
    Effect.andThen(Effect.failSync(() => new AudioThreadHung({ message: 'The audio thread stopped answering' })))
  )
}

const buildHang = (engine: OutputEngine) =>
  engine.ping('build').pipe(
    Effect.timeoutOrElse({
      duration: buildSilence,
      orElse: () => Effect.fail(new BuildThreadHung({ message: 'The build thread stopped answering' }))
    }),
    Effect.andThen(Effect.sleep(lookEvery)),
    Effect.forever
  )

/** Fails once a thread of the engine hangs, abandoning a hung audio thread first; never succeeds. */
export const hangs = (
  engine: OutputEngine,
  context: Pick<OutputContext, 'state'>
): Effect.Effect<never, AudioThreadHung | BuildThreadHung> =>
  Effect.raceFirst(audioHang(engine, context), buildHang(engine))

/** A start that doesn't end in time fails as a start does: the build thread hung on the first batch. */
export const startInTime = <A, R>(start: Effect.Effect<A, EngineStartError, R>) =>
  start.pipe(
    Effect.timeoutOrElse({
      duration: startSilence,
      orElse: () =>
        Effect.fail(
          new EngineStartError({ cause: new BuildThreadHung({ message: 'The build thread did not answer its start' }) })
        )
    })
  )
