import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: './node_modules/.cache/code-assistant-e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  timeout: 45_000,
  expect: {
    timeout: 10_000,
  },
  reporter: process.env.CI ? [['line'], ['github']] : 'list',
  use: {
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
})
