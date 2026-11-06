import { defineConfig } from 'vitest/config'

// The tests import the engine as Vite serves it: `?inline` gives a `.wasm` as data only once it counts as an asset.
export default defineConfig({ assetsInclude: ['**/*.wasm'] })
