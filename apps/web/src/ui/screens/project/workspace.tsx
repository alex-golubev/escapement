import { useAtomValue } from '@effect/atom-react'
import { Boolean, Option } from 'effect'
import type { RefObject } from 'preact'
import { useLayoutEffect, useState } from 'preact/hooks'
import {
  Group,
  type Layout,
  type LayoutChangedMeta,
  Panel as Pane,
  type PanelImperativeHandle,
  Separator,
  usePanelRef
} from 'react-resizable-panels'
import { firstView } from '../../../services/view-store'
import { useCore } from '../../core-context'
import { CentreView } from './centre'
import { Panel } from './panel'

/** The least the middle and the panel unfolded are high. */
const least = '7.5rem'

/** How high the panel's title line is: all there is of the panel folded. */
const titleHeight = '1.75rem'

const centre = 'centre'

const below = 'below'

const borderHint = `Drag to make the panel higher or lower, past its least to fold it; double-click for ${firstView.panel.share}% again`

/** The panel as the view has it, folded or as high as its share: the view leads, and the panel follows it. */
const PanelFollowsView = ({ pane }: { readonly pane: RefObject<PanelImperativeHandle | null> }) => {
  const panel = useAtomValue(useCore().view.panel)
  useLayoutEffect(
    () =>
      void Option.map(Option.fromNullishOr(pane.current), (shown) =>
        Boolean.match(panel.folded, { onTrue: () => shown.collapse(), onFalse: () => shown.resize(`${panel.share}%`) })
      ),
    [panel]
  )
  return null
}

/** Between the transport and the hint line: the middle, and the panel under it, as high as the view has it. */
export const Workspace = () => {
  const { registry, view } = useCore()
  // Read as the page opens: later heights go to the panel through the view.
  const [opened] = useState(() => registry.get(view.panel).share)
  const pane = usePanelRef()
  // The share as someone left it; folded or unfolded by the library as well, as the window gets too low for the panel.
  const laidOut = (layout: Layout, { isUserInteraction }: LayoutChangedMeta) =>
    Option.map(Option.fromNullishOr(pane.current), (shown) =>
      Boolean.match(isUserInteraction, {
        onTrue: () =>
          Option.map(Option.fromNullishOr(layout[below]), (share) => view.resized(share, shown.isCollapsed())),
        onFalse: () => view.fold(shown.isCollapsed())
      })
    )
  return (
    <main class='workspace' style={{ '--panel-title': titleHeight }}>
      <Group
        orientation='vertical'
        defaultLayout={{ [centre]: 100 - opened, [below]: opened }}
        onLayoutChanged={laidOut}
      >
        <Pane id={centre} className='workspace__pane' minSize={least}>
          <CentreView />
        </Pane>
        <Separator
          className='workspace__border'
          disableDoubleClick
          onDblClick={() => view.resized(firstView.panel.share, false)}
          data-hint={borderHint}
        />
        <Pane
          id={below}
          className='workspace__pane'
          panelRef={pane}
          minSize={least}
          collapsible
          collapsedSize={titleHeight}
        >
          <Panel />
        </Pane>
      </Group>
      <PanelFollowsView pane={pane} />
    </main>
  )
}
