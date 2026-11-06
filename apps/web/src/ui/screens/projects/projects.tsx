import { useAtomValue } from '@effect/atom-react'
import { Array, Boolean, DateTime, Effect, Option } from 'effect'
import type { ComponentChildren } from 'preact'
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { projectHref } from '../../../services/address'
import type { ListedProject } from '../../../services/project-list'
import type { Projects, Refused } from '../../../services/projects'
import { HintLine } from '../../kit/hint-line'
import { TrashIcon } from '../../kit/icons'
import { NameField } from '../../kit/name-field'
import { neighbourOf } from '../../kit/neighbour'
import { ToProjects } from '../../parts/to-projects'
import './projects.css'

/** In the interface's language, at this browser's time of day. */
export const openedText = (opened: DateTime.Utc) =>
  DateTime.formatLocal(opened, { locale: 'en', dateStyle: 'medium', timeStyle: 'short' })

/** How long a click on a name waits for a second one, which renames: the browser doesn't tell its own. */
export const doubleClickTime = '300 millis'

type Run = (effect: Effect.Effect<void>) => void

/** What a row shows: the project, its name being changed, or the question before deleting it. */
type RowMode = 'shown' | 'renaming' | 'deleting'

interface RowProps {
  readonly project: ListedProject
  readonly projects: Projects
  readonly run: Run
}

interface ModeProps extends RowProps {
  /** To another mode; with `focusBack`, the focus comes back to the row's link, as after a key that settles it. */
  readonly to: (mode: RowMode, focusBack?: boolean) => void
  readonly focusBack: boolean
}

/** Without a key held: one with Cmd, Ctrl or Shift opens the project as a link does, in a tab or window of its own. */
const plain = (event: MouseEvent) =>
  event.button === 0 && !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)

const ShownRow = ({ project, projects, run, to, focusBack }: ModeProps) => {
  const link = useRef<HTMLAnchorElement>(null)
  // A click on the name opens the project if it is still the last when the wait is over: a second, or the double
  // click it makes, stops it.
  const clicks = useRef(0)
  const stopWaiting = () => {
    clicks.current += 1
  }
  useEffect(() => stopWaiting, [])
  useLayoutEffect(() => {
    Boolean.match(focusBack, { onTrue: () => link.current?.focus(), onFalse: () => {} })
  }, [])
  const nameClicked = (event: MouseEvent) =>
    Boolean.match(plain(event), {
      onTrue: () => {
        event.preventDefault()
        stopWaiting()
        const click = clicks.current
        run(
          Effect.andThen(
            Effect.sleep(doubleClickTime),
            Effect.suspend(() =>
              Boolean.match(clicks.current === click, {
                onTrue: () => projects.open(project.id),
                onFalse: () => Effect.void
              })
            )
          )
        )
      },
      onFalse: () => {}
    })
  const keyDown = (event: KeyboardEvent) =>
    Boolean.match(event.key === 'F2', {
      onTrue: () => {
        event.preventDefault()
        to('renaming')
      },
      onFalse: () => {}
    })
  return (
    <div class='projects__row'>
      <a
        ref={link}
        class='projects__open'
        href={projectHref(project.id)}
        data-hint={`${project.name}: click to open it. Double-click the name, or press F2, to rename it`}
        onKeyDown={keyDown}
      >
        <span
          class='projects__name'
          onClick={nameClicked}
          onDblClick={() => {
            stopWaiting()
            to('renaming')
          }}
        >
          {project.name}
        </span>
        <span class='projects__opened num'>{openedText(project.opened)}</span>
      </a>
      <button
        type='button'
        class='btn projects__delete'
        aria-label={`Delete ${project.name}`}
        data-hint={`Delete ${project.name}: asks first, as it can't be undone`}
        onClick={() => to('deleting')}
      >
        <TrashIcon />
      </button>
    </div>
  )
}

const RenamingRow = ({ project, projects, run, to }: ModeProps) => (
  <div class='projects__row'>
    <div class='projects__open projects__open--editing'>
      <NameField
        name={project.name}
        label='Project name'
        hint='The name of the project: Enter or a click elsewhere keeps it, Esc leaves it as it was'
        class='projects__field'
        settled={(typed, focusBack) => {
          Option.map(typed, (name) => run(projects.rename(project.id, name)))
          to('shown', focusBack)
        }}
      />
      <span class='projects__opened num'>{openedText(project.opened)}</span>
    </div>
  </div>
)

const DeletingRow = ({ project, projects, run, to }: ModeProps) => {
  const row = useRef<HTMLDivElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  useLayoutEffect(() => {
    cancel.current?.focus()
  }, [])
  const deleted = () => {
    Option.map(neighbourOf(row.current, 'a.projects__open'), (link) => link.focus())
    run(projects.remove(project.id))
  }
  const keyDown = (event: KeyboardEvent) =>
    Boolean.match(event.key === 'Escape', { onTrue: () => to('shown', true), onFalse: () => {} })
  return (
    <div ref={row} class='projects__row projects__row--asking' onKeyDown={keyDown}>
      <span class='projects__ask'>Delete “{project.name}”? This can't be undone.</span>
      <button
        type='button'
        class='btn btn--alarm'
        data-hint={`Delete ${project.name} from this browser, for good`}
        onClick={deleted}
      >
        Delete
      </button>
      <button
        ref={cancel}
        type='button'
        class='btn'
        data-hint={`Keep ${project.name}`}
        onClick={() => to('shown', true)}
      >
        Cancel
      </button>
    </div>
  )
}

const rowOf: Record<RowMode, (props: ModeProps) => ComponentChildren> = {
  shown: ShownRow,
  renaming: RenamingRow,
  deleting: DeletingRow
}

const Row = (props: RowProps) => {
  const [{ mode, focusBack }, setShown] = useState({ mode: 'shown' as RowMode, focusBack: false })
  const Mode = rowOf[mode]
  return <Mode {...props} focusBack={focusBack} to={(mode, focusBack = false) => setShown({ mode, focusBack })} />
}

/** A panel in the middle of the page: what it is, and what can be done. */
const Panel = ({
  title,
  actions,
  children
}: {
  readonly title: string
  readonly actions: ComponentChildren
  readonly children: ComponentChildren
}) => (
  <div class='projects'>
    <section class='projects__panel'>
      <header class='projects__head'>
        <h1 class='projects__title'>{title}</h1>
        {actions}
      </header>
      {children}
    </section>
  </div>
)

const Note = ({ children }: { readonly children: ComponentChildren }) => <p class='projects__note'>{children}</p>

const ListUnavailableNote = () => (
  <Note>The list of projects didn't load: this browser's storage refused or didn't answer.</Note>
)

const refusedText: Record<Refused, string> = {
  new: "The new project wasn't made: this browser's storage refused it.",
  rename: "The project wasn't renamed: this browser's storage refused it.",
  delete: "The project wasn't deleted: this browser's storage refused it."
}

/** The projects this browser keeps, the last opened first, and New project; the hint line at the foot. */
export const ProjectsScreen = ({ projects, run }: { readonly projects: Projects; readonly run: Run }) => {
  const listed = useAtomValue(projects.listed)
  const making = useAtomValue(projects.making)
  const refused = useAtomValue(projects.refused)
  return (
    <div class='projects-screen'>
      <Panel
        title='Projects'
        actions={
          <button
            type='button'
            class='btn'
            disabled={Option.isNone(listed) || making}
            data-hint='New project: made in this browser, and opened'
            onClick={() => run(projects.newProject)}
          >
            New project
          </button>
        }
      >
        {Option.match(listed, {
          onNone: () => <ListUnavailableNote />,
          onSome: (all) =>
            Array.match(all, {
              onEmpty: () => <Note>No projects in this browser yet.</Note>,
              onNonEmpty: (all) => (
                <nav class='projects__list'>
                  {all.map((project) => (
                    <Row key={project.id} project={project} projects={projects} run={run} />
                  ))}
                </nav>
              )
            })
        })}
        {Option.match(refused, { onNone: () => null, onSome: (what) => <Note>{refusedText[what]}</Note> })}
      </Panel>
      <HintLine />
    </div>
  )
}

/** An address of a project this browser doesn't keep. */
export const NotInBrowserScreen = () => (
  <Panel title="This project isn't in this browser" actions={<ToProjects />}>
    <Note>Its address names a project this browser doesn't keep. The projects it keeps are on the list.</Note>
  </Panel>
)

/** A project's address, with the list that tells whether it is here unavailable. */
export const ListUnavailableScreen = () => (
  <Panel
    title="The project didn't open"
    actions={
      <>
        <button type='button' class='btn' onClick={() => location.reload()}>
          Reload
        </button>
        <ToProjects />
      </>
    }
  >
    <ListUnavailableNote />
  </Panel>
)
