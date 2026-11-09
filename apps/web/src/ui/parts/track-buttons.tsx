import { useAtomSet, useAtomValue } from '@effect/atom-react'
import { type Id, toggledSolo } from '@escapement/model'
import { Boolean, Option } from 'effect'
import { useCore } from '../core-context'

/** What a click on a track's name does, chosen or not: in its head and in its strip. */
export const choiceHint = (name: string, index: number, chosen: boolean, notesBelow: boolean) =>
  Boolean.match(chosen, {
    onTrue: () =>
      Boolean.match(notesBelow, {
        onTrue: () => `The notes of ${name}'s clip are below: a click shows ${name} in their place`,
        onFalse: () => `${name} is below, chosen for you only`
      }),
    onFalse: () => `Show ${name}, track ${index} of the project, below: chosen for you only`
  })

/** What a track's head and strip are named as a whole: by its place too, as two tracks may share a name. */
export const trackGroup = (name: string, index: number) => `Track ${index}: ${name}`

/** A track's M, which writes its mute for everyone, and S, which solos it for this client only. */
export const TrackToggles = ({
  id,
  name,
  mute
}: {
  readonly id: Id
  readonly name: string
  readonly mute: boolean
}) => {
  const { registry, session, ops } = useCore()
  const soloed = useAtomValue(session.isSoloed(id))
  const setListening = useAtomSet(session.listening)
  return (
    <>
      <button
        type='button'
        class='toggle toggle--shared'
        aria-label={`${name}: mute`}
        aria-pressed={mute}
        data-hint={Boolean.match(mute, {
          onTrue: () => `${name} is muted in the project, for everyone`,
          onFalse: () => `Mute ${name} in the project, for everyone`
        })}
        // The document's mute now, which may be ahead of the one drawn.
        onClick={() => Option.map(registry.get(session.project.track(id)), (now) => ops.setMute(id, !now.mute))}
      >
        M
      </button>
      <button
        type='button'
        class='toggle toggle--local'
        aria-label={`${name}: solo`}
        aria-pressed={soloed}
        data-hint={Boolean.match(soloed, {
          onTrue: () => `${name} is soloed for you only; the other tabs hear the whole arrangement`,
          onFalse: () => `Solo ${name} for you only; the other tabs won't hear the change`
        })}
        onClick={() => setListening((state) => toggledSolo(state, id))}
      >
        S
      </button>
    </>
  )
}
