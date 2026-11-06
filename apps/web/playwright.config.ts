import { defineConfig, devices } from '@playwright/test'

// Not Vite preview's own 4173: a preview of the developer's would be taken for the test's.
const port = 4183

// The page as users get it: built anew, whoever starts the tests, and served by Vite's preview with the page's headers.
export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.e2e.ts',
  forbidOnly: true,
  reporter: 'list',
  use: { baseURL: `http://localhost:${port}`, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `pnpm --dir ../.. build && pnpm preview --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: false,
    // A first build of the engine compiles Rust's std.
    timeout: 600_000
  }
})
