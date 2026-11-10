/**
 * Web command journeys (ADP-034): the browser app never mounts plugin GUI
 * bundles, so `/web-adaptive` is the one way to see and switch the mode there.
 * Driven through the real composer's slash menu on the built workspace plugin, at
 * desktop and mobile widths. Each reply line lands in the session timeline as
 * its own notice inside a collapsed "Updates" group.
 *
 * Own host per project run: creating a session on the shared host would
 * break the other specs' empty-state assertions.
 */
// covers: ["ADP-034", "ADP-035"]
import { expect, test, type Page } from "@playwright/test"
import { join } from "node:path"
import {
  HOST_PASSWORD,
  REPO_ROOT,
  rpc,
  startHost,
  type StartedHost,
} from "../runtime-e2e/helpers.js"

test.describe.configure({ mode: "serial" })

let host: StartedHost

test.beforeAll(async () => {
  // A fresh host alone missed the 1.6.1 setup crash: an older release may
  // already have published an incompatible ledger in the same process.
  host = await startHost({
    pluginEntries: [join(REPO_ROOT, "test", "fixtures", "stale-ledger"), REPO_ROOT],
  })
})

test.afterAll(async () => {
  await host.close()
})

const mode = async (): Promise<string> =>
  ((await rpc(host).settings.get()) as { mode: string }).mode

test.beforeEach(async ({ page }) => {
  await page.goto(host.baseUrl)
  await page.getByRole("button", { name: "Use password" }).click()
  await page.getByRole("textbox", { name: "Password" }).fill(HOST_PASSWORD)
  await page.getByRole("button", { name: "Connect" }).click()
  await expect(page.getByRole("textbox", { name: "Password" })).toBeHidden()
})

/**
 * A fresh session's composer. The session is created through the API and
 * opened by URL, which works at every width (the narrow layout has no
 * "New session" button on its home view).
 */
async function openComposer(page: Page): Promise<void> {
  const session = await host.client.session.create()
  const server = Buffer.from(host.baseUrl).toString("base64url")
  await page.goto(`${host.baseUrl}/server/${server}/session/${session.id}`)
  await expect(page.getByRole("textbox", { name: "Prompt" })).toBeVisible()
}

/** Type `/web-adaptive` into the composer and wait for the menu to offer it. */
async function typeSlash(page: Page): Promise<void> {
  await page.getByRole("textbox", { name: "Prompt" }).click()
  await page.keyboard.type("/web-adap")
  await expect(
    page.getByRole("button", { name: /^\/web-adaptive Adaptive mode and status/ }),
  ).toBeVisible()
}

/** Pick `/web-adaptive` from the slash menu, add the argument, and send. */
async function runCommand(page: Page, argument = ""): Promise<void> {
  await typeSlash(page)
  await page.keyboard.press("Enter")
  await expect(page.getByRole("textbox", { name: "Prompt" })).toHaveText(/^\/web-adaptive/)
  if (argument !== "") await page.keyboard.type(argument)
  await page.keyboard.press("Enter")
}

/** The reply lines, shown once the timeline's Updates groups are expanded. */
async function expectReply(page: Page, lines: readonly string[]): Promise<void> {
  await expect(async () => {
    for (const toggle of await page.getByRole("button", { name: "Updates" }).all()) {
      if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click()
    }
    for (const line of lines) {
      await expect(page.getByText(line, { exact: true })).toBeVisible({ timeout: 1000 })
    }
  }).toPass()
}

test("the slash menu offers /web-adaptive with its description", async ({ page }) => {
  await openComposer(page)
  await typeSlash(page)
})

test("/web-adaptive shows the mode and ends with how to switch it", async ({ page }) => {
  await openComposer(page)
  await runCommand(page)
  await expectReply(page, [
    "Adaptive: observe — Record decisions without applying them.",
    "No models configured yet.",
    "Switch the mode:",
    "/web-adaptive off — Adaptive does nothing",
    "/web-adaptive observe — Record decisions without applying them",
    "/web-adaptive on — Apply routing and recovery decisions",
    "/web-adaptive — show this status again",
  ])
})

test("/web-adaptive on and off switch the mode, which the server keeps", async ({ page }) => {
  await openComposer(page)
  await runCommand(page, "on")
  await expectReply(page, ["Adaptive switched to active — Apply routing and recovery decisions."])
  await expect.poll(mode).toBe("active")

  await openComposer(page)
  await runCommand(page)
  await expectReply(page, ["Adaptive: active — Apply routing and recovery decisions."])

  await openComposer(page)
  await runCommand(page, "off")
  await expectReply(page, ["Adaptive switched to off — Adaptive does nothing."])
  await expect.poll(mode).toBe("off")

  await rpc(host).settings.set({ mode: "observe" })
})

test("an unknown argument explains the usage and changes nothing", async ({ page }) => {
  await openComposer(page)
  await runCommand(page, "banana")
  await expectReply(page, ["Usage: /web-adaptive [status | on | off | observe | active]"])
  expect(await mode()).toBe("observe")
})
