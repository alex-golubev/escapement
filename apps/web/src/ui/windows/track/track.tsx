import { useAtomValue } from '@effect/atom-react'
import { HoldTarget, type Id } from '@escapement/model'
import { Boolean, Option } from 'effect'
import { Atom } from 'effect/reactivity'
import { useMemo } from 'preact/hooks'
import { useCore } from '../../core-context'
import { panThenVolume } from '../../parts/track-strip'
import { InsertField } from '../../parts/insert-field'
import { gridOf, InstanceControls } from '../../parts/instance-controls'
import { Knob } from '../../parts/knob'
import './track.css'

/**
 * A track below: its pan and volume, the same as in its head, and the mixer strip it goes into, then what plays it, its
 * controls under its name, a group to a row. Of a track no longer there, nothing.
 */
export const TrackSettings = ({ track }: { readonly track: Id }) => {
  const { session } = useCore()
  const heard = useAtomValue(session.heard).includes(track)
  return Option.match(useAtomValue(session.project.track(track)), {
    onNone: () => null,
    onSome: ({ name, strip: values, instrument, insert }) => (
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
          <span class='param'>
            <InsertField track={track} owner={name} insert={insert} />
            <span class='cap'>Strip</span>
          </span>
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
