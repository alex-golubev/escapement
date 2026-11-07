import { useAtomValue } from '@effect/atom-react'
import { useCore } from '../../core-context'
import { HintLine } from '../../kit/hint-line'
import { MenuHost } from '../../kit/menu'
import { FramesContext, useFrameLoop } from '../../parts/frames'
import { Desk, DockProvider } from './desk'
import { useHistoryKeys } from './history'
import { TransportBar } from './transport-bar'
import './project.css'

/** The transport on top, the desk with the windows below it, the hint line at the foot; a control's menu over them. */
export const App = () => {
  const { host } = useCore()
  const draws = useFrameLoop(host.frame, useAtomValue(host.state)._tag === 'Ready')
  useHistoryKeys()
  return (
    <FramesContext.Provider value={draws}>
      <DockProvider>
        <MenuHost>
          <div class='app'>
            <TransportBar />
            <Desk />
            <HintLine />
          </div>
        </MenuHost>
      </DockProvider>
    </FramesContext.Provider>
  )
}
