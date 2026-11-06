import { useAtomValue } from '@effect/atom-react'
import { type Channel, HoldTarget, type Id } from '@escapement/model'
import { Option } from 'effect'
import { Atom } from 'effect/reactivity'
import { useMemo } from 'preact/hooks'
import { useCore } from '../../core-context'
import { panThenVolume } from '../../parts/channel-strip'
import { InsertField } from '../../parts/insert-field'
import { gridOf, InstanceControls } from '../../parts/instance-controls'
import { Knob } from '../../parts/knob'
import './channel.css'

/**
 * A channel's window: its pan and volume and the mixer strip it goes into, the same as in its row, then its
 * instrument's own controls, if it has any, under the instrument's name, a group to a row. Of a channel no longer
 * there, nothing: its window closes.
 */
export const ChannelSettings = ({ channel }: { readonly channel: Id }) => {
  const { session } = useCore()
  const heard = useAtomValue(session.heard).includes(channel)
  return Option.match(useAtomValue(session.project.channel(channel)), {
    onNone: () => null,
    onSome: ({ name, strip: values, instrument, insert }) => (
      <div class='channel-settings' data-unheard={!heard}>
        <div class='channel-settings__knobs'>
          {panThenVolume.map((param) => (
            <Knob
              key={param.id}
              owner={name}
              param={param}
              value={values[param.id]}
              target={HoldTarget.ChannelStrip({ channel, param: param.id })}
            />
          ))}
          <span class='param'>
            <InsertField channel={channel} owner={name} insert={insert} />
            <span class='cap'>Strip</span>
          </span>
        </div>
        {Option.match(
          // A sampler has none: its channel's volume sets how loud.
          Option.filter(instrument, ({ plugin }) => plugin.params.length > 0),
          {
            onNone: () => null,
            onSome: (played) => (
              <section class='channel-settings__instrument' aria-label={played.plugin.label}>
                <span class='cap'>{played.plugin.label}</span>
                <div class='channel-settings__controls' style={gridOf(played.plugin)}>
                  <InstanceControls
                    owner={`${name} ${played.plugin.label.toLowerCase()}`}
                    instance={played}
                    targetOf={(param) => HoldTarget.ChannelParam({ channel, param })}
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

/** What of the channel a window's title shows, read alone: the rest of the channel changes it not. */
const useOfChannel = (channel: Id, read: (found: Channel) => string) => {
  const { session } = useCore()
  const atom = useMemo(
    () =>
      Atom.map(session.project.channel(channel), (found) => Option.match(found, { onNone: () => '', onSome: read })),
    [session, channel, read]
  )
  return useAtomValue(atom)
}

const nameOf = ({ name }: Channel) => name

const instrumentOf = ({ instrument }: Channel) =>
  Option.match(instrument, { onNone: () => '', onSome: ({ plugin }) => plugin.label })

/** The channel's name, for its window's title; none once it is gone. */
export const useChannelName = (channel: Id) => useOfChannel(channel, nameOf)

/** What plays the channel, beside its window's title. */
export const useInstrumentName = (channel: Id) => useOfChannel(channel, instrumentOf)
