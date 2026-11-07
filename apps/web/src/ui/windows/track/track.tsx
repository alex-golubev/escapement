import { useAtomValue } from '@effect/atom-react'
import { HoldTarget, type Id, type Track } from '@escapement/model'
import { Option } from 'effect'
import { Atom } from 'effect/reactivity'
import { useMemo } from 'preact/hooks'
import { useCore } from '../../core-context'
import { panThenVolume } from '../../parts/track-strip'
import { InsertField } from '../../parts/insert-field'
import { gridOf, InstanceControls } from '../../parts/instance-controls'
import { Knob } from '../../parts/knob'
import './track.css'

/**
 * A track's window: its pan and volume, the same as in its head, and the mixer strip it goes into, then its
 * instrument's own controls, if it has any, under the instrument's name, a group to a row. Of a track no longer there,
 * nothing: its window closes.
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
        {Option.match(
          // A sampler has none: its track's volume sets how loud.
          Option.filter(instrument, ({ plugin }) => plugin.params.length > 0),
          {
            onNone: () => null,
            onSome: (played) => (
              <section class='track-settings__instrument' aria-label={played.plugin.label}>
                <span class='cap'>{played.plugin.label}</span>
                <div class='track-settings__controls' style={gridOf(played.plugin)}>
                  <InstanceControls
                    owner={`${name} ${played.plugin.label.toLowerCase()}`}
                    instance={played}
                    targetOf={(param) => HoldTarget.TrackParam({ track, param })}
                  />
                </div>
              </section>
            )
          }
        )}
      </div>
    )
  })
}

/** What of the track a window's title shows, read alone: the rest of the track changes it not. */
const useOfTrack = (track: Id, read: (found: Track) => string) => {
  const { session } = useCore()
  const atom = useMemo(
    () => Atom.map(session.project.track(track), (found) => Option.match(found, { onNone: () => '', onSome: read })),
    [session, track, read]
  )
  return useAtomValue(atom)
}

const nameOf = ({ name }: Track) => name

const instrumentOf = ({ instrument }: Track) =>
  Option.match(instrument, { onNone: () => '', onSome: ({ plugin }) => plugin.label })

/** The track's name, for its window's title and the piano roll's; none once it is gone. */
export const useTrackName = (track: Id) => useOfTrack(track, nameOf)

/** What plays the track, beside its window's title. */
export const useInstrumentName = (track: Id) => useOfTrack(track, instrumentOf)
