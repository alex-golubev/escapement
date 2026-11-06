import type { ParamDescription, ParamId, Plugin } from '@escapement/engine-description'
import type { HoldTarget, PluginInstance } from '@escapement/model'
import { Array, Number, Option } from 'effect'
import { Choices } from './choices'
import { Knob } from './knob'
import './instance-controls.css'

/** The descriptions keep a group's parameters together. */
const runsOf = (params: ReadonlyArray<ParamDescription>) =>
  Array.match(params, {
    onEmpty: () => [],
    onNonEmpty: (all) => Array.groupWith(all, (one, other) => one.group === other.group)
  })

/** On a grid of a column to a knob, a row of choices takes this many: five pictures of waves are wider than a knob. */
const choiceColumns = 2

const columnsOf = (param: ParamDescription) =>
  Option.match(Option.fromNullOr(param.choices), { onNone: () => 1, onSome: () => choiceColumns })

/**
 * For a window that stands the controls of every group on one grid, so a group's knobs stand under another's: the
 * columns the widest group takes, and those a row of choices does.
 */
export const gridOf = (plugin: Plugin) => ({
  '--columns': Math.max(0, ...runsOf(plugin.params).map((run) => Number.sumAll(run.map(columnsOf)))),
  '--choice-columns': choiceColumns
})

/**
 * A control for each parameter of the plugin an instance plays, drawn from its values: its choices, or a knob. Those of
 * a group stand together after its name, as an oscillator's, and those of none together too: each window lays them out
 * as it has room, a row in a channel's, a column in a mixer strip.
 */
export const InstanceControls = ({
  owner,
  instance: { plugin, params: values },
  targetOf
}: {
  readonly owner: string
  readonly instance: PluginInstance
  readonly targetOf: (param: ParamId<Plugin>) => HoldTarget
}) => {
  const params: ReadonlyArray<ParamDescription> = plugin.params
  const control = (whose: string) => (param: ParamDescription) => {
    // Values of the plugin they were drawn for: its parameters, and no other.
    const value = (values as Record<string, number>)[param.id]
    const target = targetOf(param.id)
    return Option.match(Option.fromNullOr(param.choices), {
      onNone: () => <Knob key={param.id} owner={whose} param={param} value={value} target={target} />,
      onSome: (choices) => (
        <Choices key={param.id} owner={whose} param={param} choices={choices} value={value} target={target} />
      )
    })
  }
  return runsOf(params).map((run) =>
    Option.match(Option.fromNullOr(run[0].group), {
      onNone: () => (
        <div key={run[0].id} class='control-group'>
          <span class='control-group__controls'>{run.map(control(owner))}</span>
        </div>
      ),
      onSome: (group) => (
        <div key={group} class='control-group' role='group' aria-label={group}>
          <span class='cap control-group__name'>{group}</span>
          <span class='control-group__controls'>{run.map(control(`${owner} ${group.toLowerCase()}`))}</span>
        </div>
      )
    })
  )
}
