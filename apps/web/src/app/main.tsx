// First, so a component's own rules come after the language's; the font before the language that names it.
import '@fontsource-variable/jetbrains-mono'
import './theme.css'
import { RegistryContext } from '@effect/atom-react'
import { IndexedDb } from '@effect/platform-browser'
import { Effect, Layer, ManagedRuntime, Option } from 'effect'
import { AtomRegistry } from 'effect/reactivity'
import { type ComponentChildren, render } from 'preact'
import { viewStoresLayer } from '../browser/view-stores'
import { pageLayer } from '../browser/page'
import { projectListsLayer } from '../browser/project-list'
import { projectStoreLayer } from '../browser/project-store'
import { Address, addressOf, appBase, projectHref } from '../services/address'
import { markOpened, openListed } from '../services/project-list'
import { Projects, projectsOf } from '../services/projects'
import { OpenedProject } from '../services/session'
import { type Core, CoreContext } from '../ui/core-context'
import { App } from '../ui/screens/project/project'
import { ListUnavailableScreen, NotInBrowserScreen, ProjectsScreen } from '../ui/screens/projects/projects'
import { coreLayer, coreServices, pageLoggerLayer, registryOptions } from './core'

/** The browser's list of projects, its IndexedDB opened only where a failure is caught: a browser may have none. */
const listsLayer = projectListsLayer(IndexedDb.layerWindow)

/** Draws `page` in place of the loading line. */
const draw = (page: ComponentChildren) =>
  Effect.gen(function* () {
    const root = yield* Option.match(Option.fromNullishOr(document.getElementById('app')), {
      onNone: () => Effect.die('The page has no #app'),
      onSome: Effect.succeed
    })
    yield* Effect.sync(() => {
      // Preact draws next to what is there: the loading line goes first.
      root.replaceChildren()
      render(page, root)
    })
  })

/** Runs an action in `runtime`; a failure is logged. */
const runIn =
  <R, E>(runtime: ManagedRuntime.ManagedRuntime<R, E>): Core['run'] =>
  (effect) => {
    runtime.runFork(effect.pipe(Effect.tapCause(Effect.logError)))
  }

/** The project the list has under `id`, drawn once it is open; the engine starts with it, once the list has it. */
const projectPage = (id: string) =>
  Effect.gen(function* () {
    const opened = yield* openListed(id).pipe(Effect.provide(listsLayer))
    // The engine doesn't wait for the order of the list.
    yield* Effect.forkDetach(markOpened(opened).pipe(Effect.provide(listsLayer)))
    const runtime = ManagedRuntime.make(coreLayer.pipe(Layer.provide(Layer.succeed(OpenedProject, opened))))
    const services = yield* Effect.provideContext(Effect.all(coreServices), yield* runtime.contextEffect)
    const core: Core = { ...services, run: runIn(runtime) }
    yield* Effect.sync(() => {
      document.title = `${opened.name} — Escapement`
    })
    yield* draw(
      <RegistryContext.Provider value={core.registry}>
        <CoreContext.Provider value={core}>
          <App />
        </CoreContext.Provider>
      </RegistryContext.Provider>
    )
  }).pipe(
    Effect.catchTags({
      ListUnavailable: () => draw(<ListUnavailableScreen />),
      NotInBrowser: () => draw(<NotInBrowserScreen />)
    })
  )

/** The list of projects in this browser. */
const projectsPage = Effect.gen(function* () {
  const runtime = ManagedRuntime.make(
    Layer.effect(
      Projects,
      projectsOf((id) => Effect.sync(() => location.assign(projectHref(id))))
    ).pipe(
      Layer.provide(Layer.mergeAll(listsLayer, projectStoreLayer, viewStoresLayer, pageLayer)),
      Layer.provideMerge(AtomRegistry.layerOptions(registryOptions)),
      Layer.provideMerge(pageLoggerLayer)
    )
  )
  const context = yield* runtime.contextEffect
  const { projects, registry } = yield* Effect.provideContext(
    Effect.all({ projects: Projects, registry: AtomRegistry.AtomRegistry }),
    context
  )
  yield* draw(
    <RegistryContext.Provider value={registry}>
      <ProjectsScreen projects={projects} run={runIn(runtime)} />
    </RegistryContext.Provider>
  )
})

Effect.runFork(
  Address.$match(addressOf(location.pathname, appBase), {
    Projects: () => projectsPage,
    Project: ({ id }) => projectPage(id)
  }).pipe(Effect.tapCause(Effect.logError), Effect.provide(pageLoggerLayer))
)
