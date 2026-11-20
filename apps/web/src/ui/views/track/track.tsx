import { useAtomValue } from '@effect/atom-react'
import { byContent, HoldTarget, type Id, type PluginInstance } from '@escapement/model'
import { Boolean, Match, Option } from 'effect'
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

/** How many notes a device sounds at once, as its head says it; none for one that plays none. */
export const voicesNote = (voices: number): Option.Option<string> =>
  Option.map(
    Option.liftPredicate(voices, (voices) => voices > 0),
    (voices) => `${voices} ${Boolean.match(voices === 1, { onTrue: () => 'voice', onFalse: () => 'voices' })}`
  )

/** Whose a device's controls are, as their hints say: the track's name and the device's. */
const ownerOf = (track: string, { plugin }: PluginInstance) => `${track} ${plugin.label.toLowerCase()}`

/** An instrument's square, lit while it plays: a click turns it off or on in the project, for everyone. */
const OnSquare = ({ track, owner, on }: { readonly track: Id; readonly owner: string; readonly on: boolean }) => {
  const { registry, session, ops } = useCore()
  return (
    <button
      type='button'
      class='device__on'
      aria-label={`${owner}: on`}
      aria-pressed={on}
      data-hint={Boolean.match(on, {
        onTrue: () => `Turn ${owner} off in the project, for everyone: the track falls silent`,
        onFalse: () => `${owner} is off in the project, for everyone: the track is silent`
      })}
      // The document's now, which may be ahead of the one drawn.
      onClick={() =>
        Option.map(
          Option.flatMap(registry.get(session.project.track(track)), ({ instrument }) => instrument),
          (now) => ops.setInstrumentOn(track, !now.on)
        )
      }
    />
  )
}

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
            <section class='device' aria-label={played.plugin.label} data-off={!played.on}>
              <header class='device__head'>
                <OnSquare track={track} owner={ownerOf(name, played)} on={played.on} />
                <span class='cap device__name'>{played.plugin.label}</span>
                {Option.match(voicesNote(played.plugin.voices), {
                  onNone: () => null,
                  onSome: (note) => <span class='cap device__note'>{note}</span>
                })}
              </header>
              <Face owner={ownerOf(name, played)} track={track} instrument={played} />
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
