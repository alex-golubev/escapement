import { scheduleTask } from '@effect/atom-react'
import { Layer, Logger } from 'effect'
import { Digest } from 'effect/crypto'
import { FetchHttpClient, HttpClient } from 'effect/http'
import { AtomRegistry } from 'effect/reactivity'
import { audioOutputLayer } from '../browser/audio-output'
import { loadClocksLayer } from '../browser/load-clocks'
import { viewStoresLayer } from '../browser/view-stores'
import { pageLayer } from '../browser/page'
import { projectStoreLayer } from '../browser/project-store'
import { pageReopenLayer } from '../browser/reopen'
import { tabChannelsLayer } from '../browser/tab-channels'
import { DomainOps, domainOpsLayer } from '../services/domain-ops'
import { EngineHost, engineHostLayer, engineModuleLayer } from '../services/engine-host'
import { leavingLayer } from '../services/leaving'
import { preferencesLayer } from '../services/preferences'
import { ProjectSession, projectSessionLayer } from '../services/session'
import { TabSync, tabSyncLayer } from '../services/tab-sync'
import { Turns, turnsLayer } from '../services/turns'
import { ProjectView, projectViewLayer } from '../services/project-view'
import { keptViewsLayer, viewStoreLayer } from '../services/view-store'

/**
 * As the Effect hooks make their own: an atom a component reads while it draws lives on until the component subscribes
 * after the frame, instead of being dropped and read afresh as a new value.
 */
export const registryOptions = { scheduleTask, defaultIdleTTL: 400 }

/** By level: the browser shows an error as one, which Effect's own logger writes as a plain line. */
export const pageLoggerLayer = Logger.layer([Logger.withLeveledConsole(Logger.formatSimple)])

/**
 * The page's Effect core: the project it opened, its operations, the engine, the page's other tabs, how this browser
 * shows the project, and asking before the page goes with it unsaved, as long as it is open.
 */
export const coreLayer = Layer.mergeAll(turnsLayer, engineHostLayer, tabSyncLayer, projectViewLayer, leavingLayer).pipe(
  Layer.provideMerge(Layer.mergeAll(domainOpsLayer, viewStoreLayer, preferencesLayer)),
  // Built together: the engine's module compiles while the project, and the store of its view, load.
  Layer.provideMerge(
    Layer.mergeAll(engineModuleLayer, projectSessionLayer, keptViewsLayer, audioOutputLayer, pageReopenLayer)
  ),
  // What the browser gives the services: the page, its storage, the channels to its other tabs.
  Layer.provideMerge(Layer.mergeAll(pageLayer, projectStoreLayer, viewStoresLayer, tabChannelsLayer, loadClocksLayer)),
  Layer.provideMerge(AtomRegistry.layerOptions(registryOptions)),
  // The engine's module and the samples come over the network, the samples checked by their hashes.
  Layer.provideMerge(
    Layer.mergeAll(
      FetchHttpClient.layer,
      Digest.layerWebCrypto,
      // No tracer on the page: no spans, and no trace headers on each sample.
      Layer.succeed(HttpClient.TracerDisabledWhen, () => true),
      Layer.succeed(HttpClient.TracerPropagationEnabled, false)
    )
  ),
  Layer.provideMerge(pageLoggerLayer)
)

export const coreServices = {
  registry: AtomRegistry.AtomRegistry,
  session: ProjectSession,
  ops: DomainOps,
  turns: Turns,
  host: EngineHost,
  tabs: TabSync,
  view: ProjectView
}
