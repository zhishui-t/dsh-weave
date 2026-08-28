import { defineConfig } from '@playwright/test'

import { ART, EXECUTABLE } from './e2e/helpers'

export default defineConfig({
  testDir: 'e2e',
  outputDir: `${ART}/artifacts`,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  reporter: [['list']],
  use: {
    launchOptions: { executablePath: EXECUTABLE, headless: true },
    viewport: { width: 1440, height: 900 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
})
