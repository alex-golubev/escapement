import { useAtomValue } from '@effect/atom-react'
import { Array, Boolean, Option } from 'effect'
import { EngineState, type GaveUp, type Transport } from '../../../services/engine-host'
import type { Saving } from '../../../services/session'
import { useCore } from '../../core-context'
import { ToProjects } from '../../parts/to-projects'
import { WindowButtons } from './desk'
import { HistoryButtons } from './history'
import { PatternPicker } from './pattern-picker'
import { PlayModeSwitch } from './play-mode'
import { TempoField } from './tempo-field'
import './transport-bar.css'

const playIcon = 'M2.5 1.5 10.5 6l-8 4.5Z'
const stopIcon = 'M2.5 2.5h7v7h-7Z'

const playShape: Record<Transport, string> = { stopped: playIcon, starting: playIcon, playing: stopIcon }

const waiting = 'Play waits while the sound starts'
const stopped = 'Play: the sound is stopped, as the status on the right says'

const playHint: Record<Transport, string> = {
  stopped: 'Play: only for you, each tab listens on its own',
  starting: waiting,
  playing: 'Stop: only for you; the other tabs play on'
}

/** What Play does now, or why it can't. */
const playHintOf = (state: EngineState, transport: Transport) =>
  EngineState.$match(state, {
    Starting: () => waiting,
    Ready: () => playHint[transport],
    Failed: () => stopped,
    Hung: () => stopped
  })

/** Play wakes the sound the first time, and waits while it wakes; pressed, it plays, lit in the colour of what is yours. */
const PlayButton = () => {
  const { host, run } = useCore()
  const state = useAtomValue(host.state)
  const transport = useAtomValue(host.transport)
  return (
    <button
      type='button'
      class='btn btn--local'
      aria-label='Play'
      aria-pressed={transport === 'playing'}
      data-hint={playHintOf(state, transport)}
      disabled={state._tag !== 'Ready' || transport === 'starting'}
      onClick={() => run(host.togglePlay)}
    >
      <svg viewBox='0 0 12 12' aria-hidden='true'>
        <path d={playShape[transport]} />
      </svg>
    </button>
  )
}

/** Something the page must tell: a few words on the bar, the whole of it in the hint. */
interface Notice {
  readonly text: string
  readonly hint: string
  /** Something is lost or stopped, not only on its way. */
  readonly alarm: boolean
}

const starting: Notice = { text: 'Starting the sound…', hint: 'The sound is starting; Play waits for it', alarm: false }

const restarting: Notice = {
  text: 'Sound is restarting…',
  hint: 'The sound engine failed; a new one starts in its place and plays on',
  alarm: false
}

const gaveUpNotice: Record<GaveUp, Notice> = {
  load: {
    text: "Sound didn't load — reload the page",
    hint: "The sound engine's module didn't load",
    alarm: true
  },
  start: {
    text: "Sound can't start here",
    hint: 'The sound engine failed to start, and another would fail the same way',
    alarm: true
  },
  often: {
    text: 'Sound stopped — reload the page',
    hint: 'The sound engine failed three times within a minute, and the page stopped starting new ones',
    alarm: true
  }
}

const soundNotice = (state: EngineState, transport: Transport): Option.Option<Notice> =>
  EngineState.$match(state, {
    Starting: ({ afterFailure }) =>
      Option.some(Boolean.match(afterFailure, { onTrue: () => restarting, onFalse: () => starting })),
    Ready: () => Option.liftPredicate(starting, () => transport === 'starting'),
    Failed: ({ gaveUp }) => Option.some(gaveUpNotice[gaveUp]),
    Hung: () =>
      Option.some({
        text: 'Sound hung',
        hint: "The sound's thread stopped answering. The page reopens on its own, unless it hung three times within a minute",
        alarm: true
      })
  })

const notSaved = (text: string, hint: string): Option.Option<Notice> =>
  Option.some({ text: `Not saved: ${text}`, hint, alarm: true })

const savingNotice: Record<Saving, Option.Option<Notice>> = {
  saved: Option.none(),
  'not-loaded': notSaved("the project didn't load", "The project didn't load, and this one isn't saved"),
  missing: notSaved('the project is missing', "This browser no longer keeps the project, and this one isn't saved"),
  'erased-elsewhere': notSaved(
    'the project was deleted',
    "The project was deleted from this browser, on the list of projects or with the site's data, and this one isn't saved"
  ),
  'out-of-space': notSaved(
    'the browser is out of space',
    "Saving stopped: the browser is out of space for this site, and the latest changes aren't saved"
  ),
  refused: notSaved(
    'the browser refused',
    "Saving stopped: the browser refused to save the project, and the latest changes aren't saved"
  )
}

/** Empty while all is well; otherwise what is wrong with the sound or the saving, in a few words. */
const Status = () => {
  const { session, host } = useCore()
  const notices = Array.getSomes([
    soundNotice(useAtomValue(host.state), useAtomValue(host.transport)),
    savingNotice[useAtomValue(session.saving)]
  ])
  return (
    <div class='status' role='status'>
      {notices.map(({ text, hint, alarm }) => (
        <span key={text} class='status__notice' data-alarm={alarm} data-hint={hint}>
          {text}
        </span>
      ))}
    </div>
  )
}

/**
 * The list of projects, Pattern or Arrangement, Play, undo and redo, the tempo, the current pattern, the windows'
 * buttons; on the right, what is wrong, if anything.
 */
export const TransportBar = () => (
  <div class='transport'>
    <ToProjects />
    <span class='transport__rule' />
    <div class='transport__group'>
      <PlayModeSwitch />
      <PlayButton />
      <HistoryButtons />
    </div>
    <span class='transport__rule' />
    <div class='transport__group'>
      <span class='cap'>Tempo</span>
      <TempoField />
      <span class='cap'>BPM</span>
    </div>
    <span class='transport__rule' />
    <div class='transport__group'>
      <PatternPicker />
    </div>
    <span class='transport__rule' />
    <div class='transport__group'>
      <WindowButtons />
    </div>
    <Status />
  </div>
)
