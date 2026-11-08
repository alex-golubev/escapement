import { useAtomValue } from '@effect/atom-react'
import type { FunctionComponent } from 'preact'
import type { Centre } from '../../../services/view-store'
import { useCore } from '../../core-context'
import { Arrangement } from '../../windows/arrangement/arrangement'
import { DebugPanel } from '../../windows/debug-panel/debug-panel'
import { Mixer } from '../../windows/mixer/mixer'

/** What the middle can show: its name, its button's, and what the button tells of it. */
interface CentreKind {
  readonly title: string
  readonly button: string
  readonly hint: string
  readonly Body: FunctionComponent
}

const kinds: Record<Centre, CentreKind> = {
  arrangement: { title: 'Arrangement', button: 'Arrange', hint: 'The tracks and their clips', Body: Arrangement },
  mixer: { title: 'Mixer', button: 'Mix', hint: "The mixer's strips", Body: Mixer },
  // A tool for development: the sound's numbers, and buttons that break things on purpose.
  debug: { title: 'Debug', button: 'Debug', hint: "The sound's numbers and tools", Body: DebugPanel }
}

/** Between the transport and the panel: the Arrangement, the Mixer or Debug, as its buttons choose. */
export const CentreView = () => {
  const { title, Body } = kinds[useAtomValue(useCore().view.centre)]
  return (
    <section class='workspace__centre' aria-label={title}>
      <Body />
    </section>
  )
}

/** A button on the transport bar for each thing the middle shows, lit for the one it does. */
export const CentreButtons = () => {
  const { view } = useCore()
  const shown = useAtomValue(view.centre)
  return view.centres.map((centre) => {
    const { button, hint } = kinds[centre]
    return (
      <button
        key={centre}
        type='button'
        class='btn btn--centre'
        aria-pressed={centre === shown}
        data-hint={`${hint} in the middle: yours alone, as is what is under it`}
        onClick={() => view.turnTo(centre)}
      >
        {button}
      </button>
    )
  })
}
