import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

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
  plugins: [svelte()],
  server: { headers: isolation },
  preview: { headers: isolation },
})
