/**
 * Web E2E (ADP-042): real OpenCode web UI against an isolated host running
 * the real packed plugin. Zero retries (a flaky test is a bug — TEST_STRATEGY).
 * Primary workflows run on Chromium and WebKit; a third Chromium project
 * exercises the narrow (mobile) viewport.
 *
 * Run with `npm run e2e:web` (not part of the vitest suite — the host boots
 * a real `opencode serve` process).
 */
import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: "test/e2e-web",
  timeout: 120_000,
  globalSetup: "./test/e2e-web/harness.ts",
  globalTeardown: "./test/e2e-web/teardown.ts",
  retries: 0,
  workers: 1,
  fullyParallel: false,
  outputDir: "test-artifacts/e2e-web-results",
  use: {
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    { name: "chromium", use: { viewport: { width: 1280, height: 800 } } },
    { name: "chromium-narrow", use: { viewport: { width: 390, height: 844 } } },
    { name: "webkit", use: { viewport: { width: 1280, height: 800 } } },
  ],
})
