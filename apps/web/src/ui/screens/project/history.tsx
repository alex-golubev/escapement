import { useAtomValue } from '@effect/atom-react'
import { Boolean } from 'effect'
import { useEffect } from 'preact/hooks'
import { useCore } from '../../core-context'
import { typing } from '../../kit/keys'

/** The letter of the key, or off a Latin layout, as on Russian, the one in its place on QWERTY. */
const latinLetter = ({ key, code }: KeyboardEvent): string | undefined => {
  if (/^[a-z]$/i.test(key)) return key.toLowerCase()
  return /^Key[A-Z]$/.test(code) ? code.slice(3).toLowerCase() : undefined
}

/** Cmd or Ctrl and Z undoes, with Shift redoes; Ctrl+Y redoes too, Cmd+Y is the browser's history. */
const historyKey = (event: KeyboardEvent): 'undo' | 'redo' | undefined => {
  if (event.altKey || !(event.metaKey || event.ctrlKey) || typing(event)) return undefined
  const letter = latinLetter(event)
  if (letter === 'z') return event.shiftKey ? 'redo' : 'undo'
  return letter === 'y' && event.ctrlKey && !event.metaKey && !event.shiftKey ? 'redo' : undefined
}

/** The page's undo and redo keys, wherever the focus is but in text. */
export const useHistoryKeys = () => {
  const { ops } = useCore()
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const asked = historyKey(event)
      if (asked === undefined) return
      // Outside text, the browser has nothing of its own to undo on the page.
      event.preventDefault()
      ops[asked]()
    }
    addEventListener('keydown', onKeyDown)
    return () => removeEventListener('keydown', onKeyDown)
  }, [ops])
}

/** Undo and redo of this page's edits, grey when there is nothing to take back or make again. */
export const HistoryButtons = () => {
  const { ops } = useCore()
  const canUndo = useAtomValue(ops.canUndo)
  const canRedo = useAtomValue(ops.canRedo)
  return (
    <>
      <button
        type='button'
        class='btn'
        aria-label='Undo'
        data-hint={Boolean.match(canUndo, {
          onTrue: () => "Undo your last change to the project, Cmd+Z or Ctrl+Z; the other tabs' changes stay",
          onFalse: () => 'Nothing of yours to undo now'
        })}
        disabled={!canUndo}
        onClick={() => ops.undo()}
      >
        <svg viewBox='0 0 12 12' aria-hidden='true'>
          <path d='M4.5 2 1.5 5l3 3' />
          <path d='M2 5h5.5a2.75 2.75 0 0 1 0 5.5H5' />
        </svg>
      </button>
      <button
        type='button'
        class='btn'
        aria-label='Redo'
        data-hint={Boolean.match(canRedo, {
          onTrue: () => 'Redo your change, Cmd+Shift+Z or Ctrl+Shift+Z',
          onFalse: () => 'Nothing to redo now'
        })}
        disabled={!canRedo}
        onClick={() => ops.redo()}
      >
        <svg viewBox='0 0 12 12' aria-hidden='true'>
          <path d='m7.5 2 3 3-3 3' />
          <path d='M10 5H4.5a2.75 2.75 0 0 0 0 5.5H7' />
        </svg>
      </button>
    </>
  )
}
