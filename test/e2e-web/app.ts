/**
 * Shared web-app surface helpers: the host URL from the global setup state
 * file, the password connect flow, and the plugin-RPC bridge evaluated inside
 * the page (same origin, basic auth) — the exact channel a mounted plugin GUI
 * would use (src/ui/gui/api.ts speaks the same typed RPC).
 */
import { readFileSync } from "node:fs"
import { expect, type Page } from "@playwright/test"
import { HOST_PASSWORD } from "../runtime-e2e/helpers.js"
import { HOST_STATE_PATH } from "./state.js"

export const hostUrl = (): string =>
  (JSON.parse(readFileSync(HOST_STATE_PATH, "utf8")) as { url: string }).url

/** Host serve process id from the global setup state file. */
export const hostPid = (): number =>
  (JSON.parse(readFileSync(HOST_STATE_PATH, "utf8")) as { url: string; pid: number }).pid

/** Connect the SPA to the test host through its own password form. */
export const connect = async (page: Page, password: string, url = hostUrl()): Promise<void> => {
  await page.goto(url)
  await page.getByRole("button", { name: "Use password" }).click()
  await page.getByRole("textbox", { name: "Password" }).fill(password)
  await page.getByRole("button", { name: "Connect" }).click()
  // The success signal is viewport-neutral ("Nothing here yet" renders on
  // desktop and narrow); the Projects sidebar is desktop-only.
  await expect(page.getByText("Nothing here yet")).toBeVisible()
}

/** POST the plugin RPC from inside the page (same origin, basic auth). */
export async function rpc(
  page: Page,
  method: string,
  input?: unknown,
): Promise<Record<string, unknown>> {
  const response = await rpcRaw(page, method, input === undefined ? {} : { input })
  expect(response.ok, `rpc ${method} failed`).toBe(true)
  const payload = response.body as { output?: Record<string, unknown> }
  return payload.output ?? {}
}

export async function rpcRaw(
  page: Page,
  method: string,
  body: unknown,
): Promise<{ ok: boolean; body: unknown }> {
  const basic = Buffer.from(`opencode:${HOST_PASSWORD}`).toString("base64")
  return page.evaluate(
    async ({ url, method, body, basic }) => {
      const response = await fetch(`${url}/api/rpc/coool.adaptive/${method}`, {
        method: "POST",
        headers: { authorization: `Basic ${basic}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      })
      const parsed: unknown = await response.json()
      return { ok: response.ok, body: parsed }
    },
    { url: hostUrl(), method, body, basic },
  )
}
