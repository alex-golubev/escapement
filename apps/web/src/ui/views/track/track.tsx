import { useAtomValue } from '@effect/atom-react'
import { byContent, HoldTarget, type Id, type PluginInstance } from '@escapement/model'
import { Match, Option } from 'effect'
import { Atom } from 'effect/reactivity'
import { useMemo } from 'preact/hooks'
import { useCore } from '../../core-context'
import { SynthFace } from './synth-face'
import './track.css'

/** An instrument's controls on its card: its own face, or none, as a sampler's, whose track's volume sets how loud. */
const Face = ({
  owner,
  track,
  instrument
}: {
  readonly owner: string
  readonly track: Id
  readonly instrument: PluginInstance
}) =>
  Match.value(instrument).pipe(
    Match.discriminatorsExhaustive('name')({
      synth: (synth) => (
        <SynthFace owner={owner} synth={synth} targetOf={(param) => HoldTarget.TrackParam({ track, param })} />
      ),
      sampler: () => null,
      tone: () => null,
      filter: () => null
    })
  )

/** What of the track its chain shows, read alone: its volume, pan and mute change it not. */
const useChainOf = (track: Id) => {
  const { session } = useCore()
  const atom = useMemo(
    () =>
      byContent((get) =>
        Option.map(get(session.project.track(track)), ({ name, instrument }) => ({ name, instrument }))
      ),
    [session, track]
  )
  return useAtomValue(atom)
}

/** A track below: the devices its sound goes through, left to right, each on its card; gone, nothing. */
export const TrackChain = ({ track }: { readonly track: Id }) => {
  const { session } = useCore()
  const heard = useAtomValue(session.isHeard(track))
  return Option.match(useChainOf(track), {
    onNone: () => null,
    onSome: ({ name, instrument }) => (
      <div class='chain' data-unheard={!heard}>
        {Option.match(instrument, {
          onNone: () => null,
          onSome: (played) => (
            <section class='device' aria-label={played.plugin.label}>
              <span class='cap device__name'>{played.plugin.label}</span>
              <Face owner={`${name} ${played.plugin.label.toLowerCase()}`} track={track} instrument={played} />
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
