import { useAtomValue } from '@effect/atom-react'
import { HoldTarget, type Id } from '@escapement/model'
import { Boolean, Option } from 'effect'
import { Atom } from 'effect/reactivity'
import { useMemo } from 'preact/hooks'
import { useCore } from '../../core-context'
import { panThenVolume } from '../../parts/track-strip'
import { gridOf, InstanceControls } from '../../parts/instance-controls'
import { Knob } from '../../parts/knob'
import './track.css'

/** A track below: its pan and volume, as in its head and strip, then its instrument's controls; gone, nothing. */
export const TrackSettings = ({ track }: { readonly track: Id }) => {
  const { session } = useCore()
  const heard = useAtomValue(session.isHeard(track))
  return Option.match(useAtomValue(session.project.track(track)), {
    onNone: () => null,
    onSome: ({ name, strip: values, instrument }) => (
      <div class='track-settings' data-unheard={!heard}>
        <div class='track-settings__knobs'>
          {panThenVolume.map((param) => (
            <Knob
              key={param.id}
              owner={name}
              param={param}
              value={values[param.id]}
              target={HoldTarget.TrackStrip({ track, param: param.id })}
            />
          ))}
        </div>
        {Option.match(instrument, {
          onNone: () => null,
          onSome: (played) => (
            <section class='track-settings__instrument' aria-label={played.plugin.label}>
              <span class='cap'>{played.plugin.label}</span>
              {Boolean.match(played.plugin.params.length > 0, {
                onTrue: () => (
                  <div class='track-settings__controls' style={gridOf(played.plugin)}>
                    <InstanceControls
                      owner={`${name} ${played.plugin.label.toLowerCase()}`}
                      instance={played}
                      targetOf={(param) => HoldTarget.TrackParam({ track, param })}
                    />
                  </div>
                ),
                // A sampler has none: its track's volume sets how loud.
                onFalse: () => null
              })}
            </section>
          )
        })}
      </div>
    )
  })
}

/** The track's name, over the panel that shows it, read alone: the rest of the track changes it not. None once gone. */
export const useTrackName = (track: Id) => {
  const { session } = useCore()
  const atom = useMemo(
    () =>
      Atom.map(session.project.track(track), (found) =>
        Option.match(found, { onNone: () => '', onSome: ({ name }) => name })
      ),
    [session, track]
  )
  return useAtomValue(atom)
}
