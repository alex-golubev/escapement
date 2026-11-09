import { plugins } from '@escapement/engine-description'
import type { HoldTarget, PluginInstance } from '@escapement/model'
import { Array } from 'effect'
import { ParamControl } from '../../parts/param-control'

type Synth = Extract<PluginInstance, { readonly name: 'synth' }>
type SynthParam = (typeof plugins.synth.params)[number]

/** Where each of its groups stands: an oscillator's in a row, the envelope's beside them. A new one won't build. */
const kindOf = {
  'Osc 1': 'synth-face__osc',
  'Osc 2': 'synth-face__osc',
  'Osc 3': 'synth-face__osc',
  Envelope: 'synth-face__envelope'
} as const satisfies Record<SynthParam['group'], string>

/** Every control it has, by its groups, in the order the synth has them. */
const groups = Array.groupWith<SynthParam>(plugins.synth.params, (a, b) => a.group === b.group)

/** A synth on its card: each of its groups by its name. */
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
    {groups.map((params) => {
      const name = Array.headNonEmpty(params).group
      const whose = `${owner} ${name.toLowerCase()}`
      return (
        <div key={name} class={kindOf[name]} role='group' aria-label={name}>
          <span class='cap synth-face__name'>{name}</span>
          {params.map((param) => (
            <ParamControl
              key={param.id}
              owner={whose}
              param={param}
              value={synth.params[param.id]}
              target={targetOf(param.id)}
            />
          ))}
        </div>
      )
    })}
  </div>
)
