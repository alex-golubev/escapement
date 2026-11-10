import { useAtomValue } from '@effect/atom-react'
import { type Effect, Option } from 'effect'
import { Circle, Play, Rewind, Square } from 'lucide-preact'
import type { ComponentChildren } from 'preact'
import { EngineState, type Transport } from '../../../services/engine-host'
import { useCore } from '../../core-context'

/** Why a transport button can't be pressed now; none while the engine is ready. */
const unready = (state: EngineState, name: string): Option.Option<string> =>
  EngineState.$match(state, {
    Starting: () => Option.some(`${name} waits while the sound starts`),
    Ready: () => Option.none(),
    Failed: () => Option.some(`${name}: the sound is stopped, as the status on the right says`),
    Hung: () => Option.some(`${name}: the sound is stopped, as the status on the right says`)
  })

const playHint: Record<Transport, string> = {
  stopped: 'Play from where it stands: only for you, each tab listens on its own',
  starting: 'Play waits while the sound starts',
  playing: 'Pause: it stops where it is, only for you; the other tabs play on'
}

/** Play wakes the sound first and waits for it; lit while it plays from where it stood, pressed again it stops there. */
const PlayButton = () => {
  const { host, run } = useCore()
  const state = useAtomValue(host.state)
  const transport = useAtomValue(host.transport)
  return (
    <button
      type='button'
      class='btn btn--icon btn--main btn--on'
      aria-label='Play'
      aria-pressed={transport === 'playing'}
      data-hint={Option.getOrElse(unready(state, 'Play'), () => playHint[transport])}
      disabled={state._tag !== 'Ready' || transport === 'starting'}
      onClick={() => run(host.togglePlay)}
    >
      <Play fill='currentColor' />
    </button>
  )
}

/** A button that does `press` to the transport, once the engine is ready. */
const ReadyButton = ({
  label,
  hint,
  press,
  children
}: {
  readonly label: string
  readonly hint: string
  readonly press: Effect.Effect<void>
  readonly children: ComponentChildren
}) => {
  const { host, run } = useCore()
  const state = useAtomValue(host.state)
  return (
    <button
      type='button'
      class='btn btn--icon'
      aria-label={label}
      data-hint={Option.getOrElse(unready(state, label), () => hint)}
      disabled={state._tag !== 'Ready'}
      onClick={() => run(press)}
    >
      {children}
    </button>
  )
}

/** Back to the start, Play, Stop, and Record, which has nothing to record into yet. */
export const TransportButtons = () => {
  const { host } = useCore()
  return (
    <div class='btn-group' role='group' aria-label='Transport'>
      <ReadyButton label='To start' hint='To the start: playing on if it plays; only for you' press={host.toStart}>
        <Rewind />
      </ReadyButton>
      <PlayButton />
      <ReadyButton label='Stop' hint='Stop: back to the start; only for you, the other tabs play on' press={host.stop}>
        <Square fill='currentColor' />
      </ReadyButton>
      <button
        type='button'
        class='btn btn--icon btn--record'
        aria-label='Record'
        data-hint='Record: not yet, there is nothing to record into'
        disabled
      >
        <Circle fill='currentColor' />
      </button>
    </div>
  )
}
