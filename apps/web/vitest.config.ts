import engine from '@escapement/engine/testing/vitest'
import { mergeConfig } from 'vitest/config'
import page from './vite.config.ts'

// The page as Vite serves it, and the engine as its test harness loads it; the page's build stays as it is.
export default mergeConfig(page, engine)
