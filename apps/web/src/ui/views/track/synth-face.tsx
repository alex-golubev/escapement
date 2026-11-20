import { useAtomValue } from '@effect/atom-react'
import { paramPosition, plugins } from '@escapement/engine-description'
import { byContent, type HoldTarget, type PluginInstance } from '@escapement/model'
import { Array, Number, Option, Record } from 'effect'
import { useMemo } from 'preact/hooks'
import { useCore } from '../../core-context'
import { ParamControl } from '../../parts/param-control'

type Synth = Extract<PluginInstance, { readonly name: 'synth' }>
type SynthParam = (typeof plugins.synth.params)[number]
type EnvelopeId = Extract<SynthParam, { readonly group: 'Envelope' }>['id']

type Side = 'oscillators' | 'envelope'

/**
 * Where each of its groups stands: the oscillators one over another at the left, the envelope at the right. A new one
 * won't build.
 */
const sideOf = {
  'Osc 1': 'oscillators',
  'Osc 2': 'oscillators',
  'Osc 3': 'oscillators',
  Envelope: 'envelope'
} as const satisfies Record.ReadonlyRecord<SynthParam['group'], Side>

/** Every control it has, by its groups, in the order the synth has them. */
const groups = Array.groupWith<SynthParam>(plugins.synth.params, (a, b) => a.group === b.group)

const groupsOn = (side: Side) => groups.filter((params) => sideOf[Array.headNonEmpty(params).group] === side)

/**
 * The envelope's line, across 6 by 1 from its top left, by its knobs' positions: each stretch a sixth at most, as long
 * as its knob is turned, and the sustain a sixth at its level. A picture of the knobs, not of the formula of the sound.
 */
export const envelopeLine = (at: (param: EnvelopeId) => number): string => {
  const sustain = at('envelope.sustain')
  const stretches = [
    { long: at('envelope.delay'), to: 0 },
    { long: at('envelope.attack'), to: 1 },
    { long: at('envelope.hold'), to: 1 },
    { long: at('envelope.decay'), to: sustain },
    { long: 1, to: sustain },
    { long: at('envelope.release'), to: 0 }
  ]
  const corners = Array.scan(stretches, { x: 0, level: 0 }, ({ x }, { long, to }) => ({ x: x + long, level: to }))
  return `M${corners.map(({ x, level }) => `${Number.round(x, 4)} ${Number.round(1 - level, 4)}`).join(' L')}`
}

interface GroupProps {
  readonly params: Array.NonEmptyReadonlyArray<SynthParam>
  readonly owner: string
  readonly synth: Synth
  readonly targetOf: (param: SynthParam['id']) => HoldTarget
}

const nameOf = ({ params }: GroupProps) => Array.headNonEmpty(params).group

const Controls = (props: GroupProps) => {
  const whose = `${props.owner} ${nameOf(props).toLowerCase()}`
  return props.params.map((param) => (
    <ParamControl
      key={param.id}
      owner={whose}
      param={param}
      value={props.synth.params[param.id]}
      target={props.targetOf(param.id)}
    />
  ))
}

const Oscillator = (props: GroupProps) => (
  <div class='synth-face__osc' role='group' aria-label={nameOf(props)}>
    <span class='cap synth-face__name'>{nameOf(props)}</span>
    <Controls {...props} />
  </div>
)

/** The envelope's line as its knobs stand, one held as it is turned, here or in another tab. */
const EnvelopeCurve = ({ params, synth, targetOf }: GroupProps) => {
  const { session } = useCore()
  const line = useMemo(
    () =>
      byContent((get) => {
        const positions = Record.fromEntries(
          params.map((param) => [
            param.id,
            paramPosition(
              param,
              Option.getOrElse(get(session.held(targetOf(param.id))), () => synth.params[param.id])
            )
          ])
        )
        return envelopeLine((param) => Option.getOrElse(Record.get(positions, param), () => 0))
      }),
    [session, params, synth, targetOf]
  )
  return (
    <svg class='synth-face__curve' viewBox='0 0 6 1' preserveAspectRatio='none' aria-hidden='true'>
      <path d={useAtomValue(line)} />
    </svg>
  )
}

/** The envelope: its name and line in a window, its knobs in a row under it, in the order a note goes through them. */
const Envelope = (props: GroupProps) => (
  <div class='synth-face__envelope' role='group' aria-label={nameOf(props)}>
    <div class='device__window'>
      <span class='cap synth-face__name'>{nameOf(props)}</span>
      <EnvelopeCurve {...props} />
    </div>
    <div class='synth-face__knobs'>
      <Controls {...props} />
    </div>
  </div>
)

/** A synth on its card: its oscillators at the left, its envelope at the right. */
export const SynthFace = ({
  owner,
  synth,
  targetOf
}: {
  readonly owner: string
  readonly synth: Synth
  readonly targetOf: (param: SynthParam['id']) => HoldTarget
}) => (
  <div class='synth-face'>
    <div class='synth-face__oscillators'>
      {groupsOn('oscillators').map((params) => (
        <Oscillator
          key={Array.headNonEmpty(params).group}
          params={params}
          owner={owner}
          synth={synth}
          targetOf={targetOf}
        />
      ))}
    </div>
    {groupsOn('envelope').map((params) => (
      <Envelope
        key={Array.headNonEmpty(params).group}
        params={params}
        owner={owner}
        synth={synth}
        targetOf={targetOf}
      />
    ))}
  </div>
)
