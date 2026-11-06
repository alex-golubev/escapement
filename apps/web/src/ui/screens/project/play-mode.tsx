import { useAtomValue } from '@effect/atom-react'
import { type PlayMode, playModes } from '@escapement/model'
import { Boolean } from 'effect'
import { useEffect } from 'preact/hooks'
import { useCore } from '../../core-context'
import { typing } from '../../kit/keys'

const labels: Record<PlayMode, string> = { pattern: 'Pattern', arrangement: 'Arrangement' }

const hints: Record<PlayMode, string> = {
  pattern: 'Pattern mode: Play plays the current pattern, only for you; L switches',
  arrangement: 'Arrangement mode: Play plays the arrangement, only for you; L switches'
}

/**
 * L alone switches, by its place on the keyboard, so another layout's letter there switches too: not held down, nor
 * with a modifier.
 */
const isModeKey = (event: KeyboardEvent) =>
  event.code === 'KeyL' &&
  !event.repeat &&
  !(event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) &&
  !typing(event)

/** L switches between Pattern and Arrangement, wherever the focus is but in text. */
export const usePlayModeKeys = () => {
  const { session } = useCore()
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) =>
      Boolean.match(isModeKey(event), {
        onTrue: () => {
          event.preventDefault()
          session.toggleMode()
        },
        onFalse: () => {}
      })
    addEventListener('keydown', onKeyDown)
    return () => removeEventListener('keydown', onKeyDown)
  }, [session])
}

/**
 * Pattern or Arrangement: the mode Play plays lit in the colour of what is yours, as Play is. Each half is named its
 * mode: the Arrangement window's button reads Arrangement too.
 */
export const PlayModeSwitch = () => {
  const { session } = useCore()
  const mode = useAtomValue(session.mode)
  return (
    <span class='play-mode' role='group' aria-label='Play mode'>
      {playModes.map((choice) => (
        <button
          key={choice}
          type='button'
          class='btn btn--local'
          aria-label={`${labels[choice]} mode`}
          aria-pressed={choice === mode}
          data-hint={hints[choice]}
          onClick={() => session.chooseMode(choice)}
        >
          {labels[choice]}
        </button>
      ))}
    </span>
  )
}
