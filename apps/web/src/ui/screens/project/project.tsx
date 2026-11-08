import { useAtomValue } from '@effect/atom-react'
import { useCore } from '../../core-context'
import { HintLine } from '../../kit/hint-line'
import { MenuHost } from '../../kit/menu'
import { FramesContext, useFrameLoop } from '../../parts/frames'
import { CentreView } from './centre'
import { useHistoryKeys } from './history'
import { Panel } from './panel'
import { TransportBar } from './transport-bar'
import './project.css'

/** The transport on top, the middle, the panel under it, the hint line at the foot; a control's menu over them. */
export const App = () => {
  const { host } = useCore()
  const draws = useFrameLoop(host.frame, useAtomValue(host.state)._tag === 'Ready')
  useHistoryKeys()
  return (
    <FramesContext.Provider value={draws}>
      <MenuHost>
        <div class='app'>
          <TransportBar />
          <main class='workspace'>
            <CentreView />
            <Panel />
          </main>
          <HintLine />
        </div>
      </MenuHost>
    </FramesContext.Provider>
  )
}
