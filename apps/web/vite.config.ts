// The barrel would load all of Effect at each start of Vite.
import * as Boolean from 'effect/Boolean'
import { type Connect, defineConfig, type Plugin } from 'vite'
import { reopenPage } from './src/browser/reopen-page.ts'

// SharedArrayBuffer is only available on cross-origin isolated pages.
const crossOriginIsolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp'
}

/** Every response but the page the app reopens through: that one must get a process of its own. */
const isolate =
  (base: string): Connect.NextHandleFunction =>
  (request, response, next) => {
    Boolean.match(new URL(request.url ?? '/', 'http://page').pathname === `${base}${reopenPage}`, {
      onTrue: () => {},
      onFalse: () => Object.entries(crossOriginIsolation).forEach(([name, value]) => response.setHeader(name, value))
    })
    next()
  }

const crossOriginIsolated: Plugin = {
  name: 'cross-origin-isolated',
  configureServer: (server) => void server.middlewares.use(isolate(server.config.base)),
  configurePreviewServer: (server) => void server.middlewares.use(isolate(server.config.base))
}

export default defineConfig({
  plugins: [crossOriginIsolated],
  build: {
    rolldownOptions: {
      // The Effect hooks mark their React server parts "use client"; the page has no server.
      checks: { moduleLevelDirective: false }
    }
  }
})
