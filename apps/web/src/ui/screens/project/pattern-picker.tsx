import { useAtomValue } from '@effect/atom-react'
import { canDeletePattern, type Id } from '@escapement/model'
import { Boolean, Option } from 'effect'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { useCore } from '../../core-context'
import { BlankIcon, CheckIcon, ChevronIcon, CopyIcon, PencilIcon, TrashIcon } from '../../kit/icons'
import { typing } from '../../kit/keys'
import { type MenuItem, useContextMenu, useMenuButton } from '../../kit/menu'
import { NameField } from '../../kit/name-field'

/** Adds a pattern to the project and makes it current on this page; none in the middle of a gesture. */
const useAddPattern = () => {
  const { ops, session } = useCore()
  return useCallback(() => Option.map(ops.addPattern(), session.choosePattern), [ops, session])
}

/** F4 alone adds a pattern: not held down, nor with Alt, which closes a window on Windows. */
const isPatternKey = (event: KeyboardEvent) =>
  event.key === 'F4' &&
  !event.repeat &&
  !(event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) &&
  !typing(event)

/** F4 adds a pattern, wherever the focus is but in text. */
export const usePatternKeys = () => {
  const add = useAddPattern()
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) =>
      Boolean.match(isPatternKey(event), {
        onTrue: () => {
          event.preventDefault()
          add()
        },
        onFalse: () => {}
      })
    addEventListener('keydown', onKeyDown)
    return () => removeEventListener('keydown', onKeyDown)
  }, [add])
}

/** The current pattern's menu: rename, clone, and delete but the last one live. */
const usePatternMenu = (current: Option.Option<Id>, name: string, rename: (pattern: Id) => void) => {
  const { ops, registry, session } = useCore()
  return useContextMenu(() => ({
    title: name,
    items: Option.match(current, {
      onNone: () => [],
      onSome: (id): ReadonlyArray<MenuItem> => [
        { label: 'Rename', icon: <PencilIcon />, hint: `Rename ${name}, for everyone`, chosen: () => rename(id) },
        {
          label: 'Clone',
          icon: <CopyIcon />,
          hint: `Copy ${name} with its notes after it, for everyone, and make the copy current`,
          chosen: () => Option.map(ops.clonePattern(id), session.choosePattern)
        },
        ...Boolean.match(canDeletePattern(registry.get(session.project.patternIds), id), {
          onTrue: () => [
            {
              label: 'Delete',
              icon: <TrashIcon />,
              hint: `Delete ${name} from the project, for everyone; the pattern next to it becomes current. Cmd+Z or Ctrl+Z brings it back`,
              chosen: () => ops.deletePattern(id)
            }
          ],
          onFalse: () => []
        })
      ]
    })
  }))
}

/**
 * The current pattern's name: a click opens the list of the patterns to choose another; F2 renames it, as does its
 * menu, which also clones and deletes it. Drawn again after a key settled its name, it takes the focus back.
 */
const PatternName = ({
  current,
  name,
  focusBack,
  rename
}: {
  readonly current: Option.Option<Id>
  readonly name: string
  readonly focusBack: boolean
  readonly rename: (pattern: Id) => void
}) => {
  const { registry, session } = useCore()
  const button = useRef<HTMLButtonElement>(null)
  useLayoutEffect(() => {
    Boolean.match(focusBack, { onTrue: () => button.current?.focus(), onFalse: () => {} })
  }, [])
  const nameOf = (id: Id) => Option.getOrElse(registry.get(session.project.patternName(id)), () => '')
  const list = useMenuButton(() => ({
    title: 'Patterns',
    items: registry.get(session.project.patternIds).map((id) => {
      const checked = Option.contains(registry.get(session.pattern), id)
      const label = nameOf(id)
      return {
        label,
        icon: Boolean.match(checked, { onTrue: () => <CheckIcon />, onFalse: () => <BlankIcon /> }),
        hint: `Make ${label} the current pattern: only for you, each tab has its own`,
        checked,
        chosen: () => session.choosePattern(id)
      }
    })
  }))
  const menu = usePatternMenu(current, name, rename)
  return (
    <button
      ref={button}
      type='button'
      class='btn pattern-pick'
      aria-label={`Pattern: ${name}`}
      data-hint={`${name} is the current pattern, only for you: the Channels window and the piano roll show it, Play plays it in Pattern mode. Click to choose another; F2 renames it; a right click or Shift+F10, its menu`}
      disabled={Option.isNone(current)}
      {...list}
      onContextMenu={menu.onContextMenu}
      onKeyDown={(event) =>
        Boolean.match(event.key === 'F2', {
          onTrue: () => {
            event.preventDefault()
            Option.map(current, rename)
          },
          onFalse: () => menu.onKeyDown(event)
        })
      }
    >
      <span class='pattern-pick__name'>{name}</span>
      <ChevronIcon />
    </button>
  )
}

/** + beside the current pattern's name adds one; which is current is this page's own. */
export const PatternPicker = () => {
  const { ops, session } = useCore()
  const current = useAtomValue(session.pattern)
  const name = Option.getOrElse(useAtomValue(session.patternName), () => 'No pattern')
  const add = useAddPattern()
  // The one being renamed, should another become current meanwhile.
  const [naming, setNaming] = useState({ renaming: Option.none<Id>(), focusBack: false })
  // Another one current, as one deleted elsewhere meanwhile, takes the field with it, as a channel's row does; back, it
  // has none.
  useLayoutEffect(
    () =>
      setNaming((was) => ({
        ...was,
        renaming: Option.filter(was.renaming, (pattern) => Option.contains(current, pattern))
      })),
    [current]
  )
  return (
    <>
      <span class='cap'>Pattern</span>
      {Option.match(naming.renaming, {
        onSome: (pattern) => (
          <NameField
            name={name}
            label='Name of the current pattern'
            hint='The name of the pattern, for everyone: Enter or a click elsewhere keeps it, Esc leaves it as it was'
            class='pattern-pick__field'
            settled={(typed, focusBack) => {
              Option.map(typed, (named) => ops.renamePattern(pattern, named))
              setNaming({ renaming: Option.none(), focusBack })
            }}
          />
        ),
        onNone: () => (
          <PatternName
            current={current}
            name={name}
            focusBack={naming.focusBack}
            rename={(pattern) => setNaming({ renaming: Option.some(pattern), focusBack: false })}
          />
        )
      })}
      <button
        type='button'
        class='btn'
        aria-label='Add a pattern'
        data-hint='Add a pattern to the project, for everyone, and make it current, F4'
        onClick={add}
      >
        +
      </button>
    </>
  )
}
