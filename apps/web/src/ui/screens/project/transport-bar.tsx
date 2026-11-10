import { useAtomValue } from '@effect/atom-react'
import { ticksPerQuarter } from '@escapement/engine-description'
import { barTicks } from '@escapement/model'
import { Array, Boolean, Option } from 'effect'
import { EngineState, type GaveUp, type Transport } from '../../../services/engine-host'
import type { Saving } from '../../../services/session'
import { useCore } from '../../core-context'
import { ToProjectsIcon } from '../../parts/to-projects'
import { Clock } from './clock'
import { HistoryButtons } from './history'
import { DspLoadMeter } from './dsp-load'
import { TempoField } from './tempo-field'
import { TransportButtons } from './transport-buttons'
import './transport-bar.css'

/** Something the page must tell: a few words on the bar, cut short if there is no room; all of it in the hint. */
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
    hint: "The sound engine's module didn't load: reload the page",
    alarm: true
  },
  start: {
    text: "Sound can't start here",
    hint: 'The sound engine failed to start, and another would fail the same way',
    alarm: true
  },
  often: {
    text: 'Sound stopped — reload the page',
    hint: 'The sound engine failed three times within a minute, and the page stopped starting new ones: reload the page',
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
          <span class='status__text'>{text}</span>
        </span>
      ))}
    </div>
  )
}

/** Every bar is as many quarter notes as the model's: read only, until a project has a time signature of its own. */
const TimeSignature = () => {
  const signature = `${barTicks / ticksPerQuarter}/4`
  return (
    <span class='field field--readout field--quiet' data-hint={`${signature}: every bar, until time signatures come`}>
      {signature}
    </span>
  )
}

/** Projects, the transport, undo and redo, where it is heard, the tempo; on the right, the status and the load. */
export const TransportBar = () => (
  <div class='transport'>
    <ToProjectsIcon />
    <TransportButtons />
    <div class='btn-group'>
      <HistoryButtons />
    </div>
    <Clock />
    <div class='transport__metre'>
      <TempoField />
      <TimeSignature />
    </div>
    <Status />
    <div class='transport__meters'>
      <DspLoadMeter />
    </div>
  </div>
)
