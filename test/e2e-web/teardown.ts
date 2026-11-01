/**
 * Web E2E teardown (ADP-042): closes every host the setup booted via the
 * shared registry in the runtime helpers (the live handle cannot cross the
 * setup/teardown module boundary).
 */
import { rmSync } from "node:fs"
import { closeAllHosts } from "../runtime-e2e/helpers.js"
import { HOST_STATE_PATH } from "./state.js"

export default async function teardown(): Promise<void> {
  await closeAllHosts()
  rmSync(HOST_STATE_PATH, { force: true })
}
