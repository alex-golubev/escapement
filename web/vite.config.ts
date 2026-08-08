import { defineConfig } from 'vitest/config'
import { svelte } from '@sveltejs/vite-plugin-svelte'

import { engineFreshness, workletBundle } from './plugins/artifacts.ts'

// Cross-origin isolation. Without these two headers `SharedArrayBuffer` does
// not exist, and the entire UI -> audio link goes with it: commands reach the
// worklet through a ring buffer in shared memory, and there is no fallback
// path behind it.
//
// `preview` needs them just as much as `dev`. Without that, the built app
// behaves differently from the dev server and SAB disappears exactly where you
// have stopped expecting it. Production hosting must send the same two headers
// — that is a requirement on the host, not a detail of this config.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

export default defineConfig({
  // The two artifact plugins are the reason the worklet no longer has to be
  // rebuilt by hand, and the reason a stale engine says so. Both are in
  // plugins/artifacts.ts, with the reasoning.
  plugins: [svelte(), workletBundle(), engineFreshness()],
  server: { headers: isolation },
  preview: { headers: isolation },
  test: {
    // Nothing under test needs a DOM: the engine tests read the compiled wasm
    // off disk and call it. A test that does need one asks for it per file,
    // rather than every suite paying for jsdom it does not use.
    environment: 'node',
    // Tests sit next to the module they cover; `tests/` holds the two things
    // that have no module to sit next to — what examines a build artifact,
    // and the support the suites share.
    include: ['src/**/*.spec.ts', 'tests/**/*.spec.ts'],
  },
})
