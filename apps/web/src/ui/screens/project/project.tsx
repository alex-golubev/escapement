import { useAtomValue } from '@effect/atom-react'
import { useMemo } from 'preact/hooks'
import { useCore } from '../../core-context'
import { HintLine } from '../../kit/hint-line'
import { MenuHost } from '../../kit/menu'
import { FramesContext, useFrameLoop } from '../../parts/frames'
import { MeterBoardContext, meterBoard } from '../../parts/meter-board'
import { CentreButtons } from './centre'
import { useHistoryKeys } from './history'
import { TransportBar } from './transport-bar'
import { Workspace } from './workspace'
import './project.css'

/** The transport on top, the middle, the panel under it, the hint line and what the middle shows at the foot. */
export const App = () => {
  const { host } = useCore()
  const draws = useFrameLoop(host.frame, useAtomValue(host.state)._tag === 'Ready')
  const meters = useMemo(meterBoard, [])
  useHistoryKeys()
  return (
    <FramesContext.Provider value={draws}>
      <MeterBoardContext.Provider value={meters}>
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
      </MeterBoardContext.Provider>
    </FramesContext.Provider>
  )
}
