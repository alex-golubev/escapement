import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [tailwindcss()],
  // The page and what it loads come from one origin: nothing inline, so the server's policy forbids the rest.
  build: { assetsInlineLimit: 0 }
})
