import type { ParamDescription } from '@escapement/engine-description'
import type { HoldTarget } from '@escapement/model'
import { Option } from 'effect'
import { Choices } from './choices'
import { Knob } from './knob'

/** A parameter's control, as its description has it: its choices, or a knob. */
export const ParamControl = ({
  owner,
  param,
  value,
  target
}: {
  readonly owner: string
  readonly param: ParamDescription
  readonly value: number
  readonly target: HoldTarget
}) =>
  Option.match(Option.fromNullOr(param.choices), {
    onNone: () => <Knob owner={owner} param={param} value={value} target={target} />,
    onSome: (choices) => <Choices owner={owner} param={param} choices={choices} value={value} target={target} />
  })
