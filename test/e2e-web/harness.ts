/**
 * Web E2E harness (ADP-042): boots one isolated host (real `opencode serve`
 * + fake provider + packed plugin) for the whole run and records its URL in
 * a state file the tests read. Playwright runs this module as global setup.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { startHost } from "../runtime-e2e/helpers.js"
import { HOST_STATE_PATH } from "./state.js"

export default async function boot(): Promise<void> {
  rmSync(HOST_STATE_PATH, { force: true })
  const host = await startHost({})
  mkdirSync("test-artifacts", { recursive: true })
  writeFileSync(HOST_STATE_PATH, JSON.stringify({ url: host.baseUrl }))
}
