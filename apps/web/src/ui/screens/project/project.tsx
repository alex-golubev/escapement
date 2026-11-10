import { useAtomValue } from '@effect/atom-react'
import { useCore } from '../../core-context'
import { HintLine } from '../../kit/hint-line'
import { MenuHost } from '../../kit/menu'
import { FramesContext, useFrameLoop } from '../../parts/frames'
import { CentreButtons } from './centre'
import { useHistoryKeys } from './history'
import { TransportBar } from './transport-bar'
import { Workspace } from './workspace'
import './project.css'

/** The transport on top, the middle, the panel under it, the hint line and what the middle shows at the foot. */
export const App = () => {
  const { host } = useCore()
  const draws = useFrameLoop(host.frame, useAtomValue(host.state)._tag === 'Ready')
  useHistoryKeys()
  return (
    <FramesContext.Provider value={draws}>
      <MenuHost>
        <div class='app'>
          <TransportBar />
          <Workspace />
          <footer class='foot'>
            <HintLine />
            <div class='btn-group'>
              <CentreButtons />
            </div>
          </footer>
        </div>
      </MenuHost>
    </FramesContext.Provider>
  )
}
