import { useAtomValue } from '@effect/atom-react'
import { type BenchmarkResult, EngineEvent, type PlaybackStats } from '@escapement/engine'
import { gainText } from '@escapement/engine-description'
import { Boolean, Cause, Effect, Match, Option, Predicate } from 'effect'
import { useRef } from 'preact/hooks'
import {
  type BenchmarkFailure,
  BenchmarkState,
  EngineState,
  LoadState,
  type Restarts,
  type RunFailure
} from '../../../services/engine-host'
import { type Decoded, type SampleLine, shortHash, statusText } from '../../../services/samples'
import { useCore } from '../../core-context'
import { setText, useFrame } from '../../parts/frames'
import './debug-panel.css'

const nameAndMessage = (error: Error) => [error.name, error.message].filter(Predicate.isTruthy).join(': ')

/** A bug's or the platform's error in its own words: its name and message, then its cause's. */
const describe = (error: unknown) =>
  Option.match(Option.liftPredicate(error, Predicate.isError), {
    onNone: () => String(error),
    onSome: (error) => [error, error.cause].filter(Predicate.isError).map(nameAndMessage).join(': ')
  })

/** A failure by its kind, each in its own words for now: a new kind doesn't compile until the panel names it. */
const errorText = (error: RunFailure | BenchmarkFailure) =>
  Match.valueTags(error, {
    EngineLoadError: describe,
    EngineStartError: describe,
    ProcessorError: describe,
    BuildThreadError: describe,
    CommandStreamError: describe,
    AudioThreadHung: describe,
    BuildThreadHung: describe,
    BenchmarkSoundLost: describe,
    TimeoutError: describe
  })

/** The failure's error, or a bug in its own words. */
const failureText = (cause: Cause.Cause<RunFailure | BenchmarkFailure>) =>
  Option.match(Cause.findErrorOption(cause), { onNone: () => describe(Cause.squash(cause)), onSome: errorText })

const engineText = (state: EngineState, awake: boolean) =>
  EngineState.$match(state, {
    Starting: () => 'starting…',
    Ready: () => Boolean.match(awake, { onTrue: () => 'running', onFalse: () => 'asleep until Play' }),
    Failed: ({ cause }) => `failed: ${failureText(cause)}`,
    Hung: ({ error }) => `hung: ${errorText(error)}`
  })

const restartsText = ({ count, last, backInMs }: Restarts) =>
  [
    `restarts: ${count}`,
    ...Option.toArray(Option.map(last, (cause) => ` (last: ${failureText(cause)})`)),
    ...Option.toArray(Option.map(backInMs, (ms) => ` · back in ${Math.round(ms)} ms`))
  ].join('')

const loadText = (state: LoadState) =>
  LoadState.$match(state, {
    Idle: () => '',
    Running: () => 'Load: turning the filter and rebuilding…',
    Done: ({ moves, rebuilds, seconds }) =>
      `Load: ${moves} moves of the filter and ${rebuilds} rebuilds in ${seconds.toFixed(1)} s`,
    Asleep: () => 'Load failed: The engine sleeps until Play',
    NoFilter: () => 'Load failed: No filter on the master',
    Failed: ({ cause }) => `Load failed: ${failureText(cause)}`
  })

/** The main thread busy, as with a long task of the page: the engine plays on without it. */
const freeze = Effect.sync(() => {
  const end = performance.now() + 1000
  while (performance.now() < end) {}
})

/** Seconds as milliseconds, milliseconds as microseconds, to a tenth. */
const thousandths = (value: number) => (value * 1000).toFixed(1)

const dropoutsText = (stats: PlaybackStats | undefined) =>
  stats === undefined
    ? 'not reported by this browser'
    : `${stats.underrunEvents} (${thousandths(stats.underrunDuration)} ms)`

/** Numbers from the engine's board and the browser, written by the frame; dashes without an engine. */
const TelemetryLine = () => {
  const fields = {
    blocks: useRef<HTMLOutputElement>(null),
    epoch: useRef<HTMLOutputElement>(null),
    levelDb: useRef<HTMLOutputElement>(null),
    lostEvents: useRef<HTMLOutputElement>(null),
    lostNotes: useRef<HTMLOutputElement>(null),
    heapCalls: useRef<HTMLOutputElement>(null),
    playhead: useRef<HTMLOutputElement>(null),
    dropouts: useRef<HTMLOutputElement>(null)
  }
  useFrame((frame) => {
    const telemetry = frame?.telemetry
    setText(fields.blocks.current, telemetry === undefined ? '—' : String(telemetry.blocks))
    setText(fields.epoch.current, telemetry === undefined ? '—' : String(telemetry.epoch))
    setText(fields.lostEvents.current, telemetry === undefined ? '—' : String(telemetry.lostEvents))
    setText(fields.lostNotes.current, telemetry === undefined ? '—' : String(telemetry.lostNotes))
    setText(fields.heapCalls.current, telemetry === undefined ? '—' : String(telemetry.heapCalls))
    setText(
      fields.playhead.current,
      telemetry === undefined ? '—' : telemetry.playing ? `${telemetry.position} ticks` : 'stopped'
    )
    setText(
      fields.levelDb.current,
      Option.match(Option.fromUndefinedOr(telemetry), {
        onNone: () => '—',
        onSome: ({ peaks }) => gainText(Math.max(...peaks))
      })
    )
    setText(fields.dropouts.current, frame === undefined ? '—' : dropoutsText(frame.stats))
  })
  return (
    <>
      <p>
        Blocks <output ref={fields.blocks} /> · session <output ref={fields.epoch} /> · level{' '}
        <output ref={fields.levelDb} /> · lost events <output ref={fields.lostEvents} /> · lost notes{' '}
        <output ref={fields.lostNotes} /> · engine heap calls <output ref={fields.heapCalls} /> · playhead{' '}
        <output ref={fields.playhead} />
      </p>
      <p>
        Audio output, since the context started: dropouts <output ref={fields.dropouts} />
      </p>
    </>
  )
}

/** The file's length and hash, checked against the manifest. */
const decodedText = ({ seconds, sha256 }: Decoded) => `${seconds.toFixed(2)} s · ${shortHash(sha256)} ✓`

const lineText = ({ name, hash, decoded, loads, status }: SampleLine) => {
  const file = decoded === undefined ? (hash === undefined ? [] : [shortHash(hash)]) : [decodedText(decoded)]
  return [name, ...file, statusText(status), `loads: ${loads}`].join(' · ')
}

const SampleList = () => {
  const { host } = useCore()
  const lines = useAtomValue(host.samples)
  return (
    <ul aria-label='Samples'>
      {lines.map((line) => (
        <li key={line.name} title={line.decoded?.sha256 ?? line.hash ?? ''}>
          {lineText(line)}
        </li>
      ))}
    </ul>
  )
}

const describeEvent = (event: EngineEvent) =>
  EngineEvent.$match(event, {
    CommandRejected: ({ reason }) => `command rejected: ${reason}`,
    CommandStreamLost: () => 'command stream lost',
    EditRejected: ({ batch, reason }) => `edit of batch ${batch} rejected: ${reason}`
  })

const EventList = () => {
  const { host } = useCore()
  const events = useAtomValue(host.events)
  return (
    <ul aria-label='Engine events'>
      {events.map(({ number, event }) => (
        <li key={number}>{`session ${event.epoch} · ${describeEvent(event)}`}</li>
      ))}
    </ul>
  )
}

const resultText = ({ msPerBlock, minMsPerBlock, maxMsPerBlock, budgetMs, runs, hasPerformanceNow }: BenchmarkResult) =>
  `process(): ${thousandths(msPerBlock)} µs per block ` +
  `(median of ${runs} runs, ${thousandths(minMsPerBlock)}–${thousandths(maxMsPerBlock)}), ` +
  `${((msPerBlock / budgetMs) * 100).toFixed(2)}% of the ${budgetMs.toFixed(2)} ms budget` +
  ` · performance.now() in worklet: ${hasPerformanceNow ? 'yes' : 'no'}`

const benchmarkText = (state: BenchmarkState) =>
  BenchmarkState.$match(state, {
    Idle: () => '',
    Rendering: () => 'Rendering…',
    Done: ({ result }) => resultText(result),
    Failed: ({ cause }) => `Benchmark failed: ${failureText(cause)}`
  })

/** What the slice is checked by: the engine's state and numbers, and what it must refuse. */
export const DebugPanel = () => {
  const { session, host, tabs, run } = useCore()
  const state = useAtomValue(host.state)
  const awake = useAtomValue(host.awake)
  const restarts = useAtomValue(host.restarts)
  const benchmark = useAtomValue(host.benchmark)
  const load = useAtomValue(host.load)
  const saved = useAtomValue(session.saving) === 'saved'
  const syncing = useAtomValue(tabs.on)
  const ready = state._tag === 'Ready'
  return (
    <div class='debug'>
      <p>
        crossOriginIsolated: {String(crossOriginIsolated)} · engine: {engineText(state, awake)} ·{' '}
        {restartsText(restarts)}
      </p>
      <p>
        <button type='button' class='btn' disabled={state._tag === 'Hung'} onClick={() => run(host.restart)}>
          Restart engine
        </button>{' '}
        <button type='button' class='btn' disabled={!ready} onClick={() => run(host.rebuild)}>
          Rebuild
        </button>{' '}
        <button type='button' class='btn' disabled={!saved} onClick={() => run(session.breakSaving)}>
          Break saving
        </button>{' '}
        <button type='button' class='btn' onClick={() => run(tabs.toggle)}>
          {Boolean.match(syncing, { onTrue: () => 'Sync off', onFalse: () => 'Sync on' })}
        </button>{' '}
        <button type='button' class='btn' disabled={!ready} onClick={() => run(host.sendBadCommand)}>
          Send bad command
        </button>{' '}
        <button type='button' class='btn' disabled={!ready} onClick={() => run(host.storeBadSample)}>
          Send bad sample
        </button>{' '}
        <button type='button' class='btn' disabled={!ready} onClick={() => run(host.panicAudio)}>
          Panic audio
        </button>{' '}
        <button type='button' class='btn' disabled={!ready} onClick={() => run(host.panicBuild)}>
          Panic build
        </button>{' '}
        <button type='button' class='btn' disabled={!ready} onClick={() => run(host.hangAudio)}>
          Hang audio
        </button>{' '}
        <button type='button' class='btn' disabled={!ready} onClick={() => run(host.hangBuild)}>
          Hang build
        </button>{' '}
        <button type='button' class='btn' disabled={!ready} onClick={() => run(host.breakStream)}>
          Break stream
        </button>{' '}
        <button
          type='button'
          class='btn'
          disabled={benchmark._tag === 'Rendering'}
          onClick={() => run(host.runBenchmark)}
        >
          Benchmark
        </button>{' '}
        <button type='button' class='btn' onClick={() => run(freeze)}>
          Freeze 1 s
        </button>{' '}
        <button
          type='button'
          class='btn'
          disabled={!ready || !awake || load._tag === 'Running'}
          onClick={() => run(host.runLoad)}
        >
          Load 10 s
        </button>
      </p>
      <TelemetryLine />
      <SampleList />
      <p>{benchmarkText(benchmark)}</p>
      <p>{loadText(load)}</p>
      <EventList />
    </div>
  )
}
