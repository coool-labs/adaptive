/**
 * Web E2E journeys over the real OpenCode web UI (ADP-042): connection,
 * first-install state, host settings navigation, plugin visibility, and the
 * documented platform limitation that plugin GUI surfaces do not mount in
 * the browser-served app (GOAL.md escape-hatch rule).
 *
 * Semantic locators only (roles + accessible names); zero retries per
 * playwright.config.ts.
 */
import { expect, test, type Page } from "@playwright/test"
import { HOST_PASSWORD } from "../runtime-e2e/helpers.js"
import { connect, hostUrl, rpc, rpcRaw } from "./app.js"

/** Open the host settings from the home view, on either viewport layout. */
const openSettings = async (page: Page): Promise<void> => {
  const settings = page.getByRole("button", { name: "Settings" })
  if (await settings.isVisible().catch(() => false)) {
    await settings.click()
  } else {
    // Narrow layout: Settings lives in the banner "Tabs" dialog (the
    // Projects drawer only offers All projects / Add project).
    await page.getByRole("banner").getByRole("button", { name: "Tabs" }).click()
    await settings.click()
  }
}

test.describe("connection journeys", () => {
  test("first install connects with the server password and shows the empty state", async ({
    page,
  }) => {
    await connect(page, HOST_PASSWORD)
    await expect(page.getByText("Nothing here yet")).toBeVisible()
    await expect(page.getByText("Create a session to get started")).toBeVisible()
  })

  test("a wrong password is an error state, not a silent failure", async ({ page }) => {
    await page.goto(hostUrl())
    await page.getByRole("button", { name: "Use password" }).click()
    await page.getByRole("textbox", { name: "Password" }).fill("not-the-password")
    await page.getByRole("button", { name: "Connect" }).click()
    await expect(page.getByRole("textbox", { name: "Password" })).toBeVisible()
    await expect(page.getByRole("complementary", { name: "Projects" })).toBeHidden()
  })

  test("the connect form is keyboard-operable", async ({ page }) => {
    await page.goto(hostUrl())
    await page.getByRole("button", { name: "Use password" }).click()
    await page.getByRole("textbox", { name: "Password" }).pressSequentially(HOST_PASSWORD)
    await page.keyboard.press("Enter")
    await expect(page.getByText("Nothing here yet")).toBeVisible()
  })
})

test.describe("settings surfaces", () => {
  // At narrow width the settings tablist is collapsed (the page lands on
  // Preferences with a Back-to-app affordance), so tab-driven journeys run
  // on desktop only; narrow asserts the page renders (see below).
  const skipNarrow = (): void => {
    test.skip(
      test.info().project.name === "chromium-narrow",
      "settings tablist is collapsed at narrow width",
    )
  }

  test("host settings open and expose the documented tabs", async ({ page }) => {
    skipNarrow()
    await connect(page, HOST_PASSWORD)
    await openSettings(page)
    await expect(page.getByRole("tab", { name: "Providers" })).toBeVisible()
    await expect(page.getByRole("tab", { name: "Models" })).toBeVisible()
    await expect(page.getByRole("tab", { name: "Extensions" })).toBeVisible()
  })

  test("the models catalog search finds the fake provider's model", async ({ page }) => {
    skipNarrow()
    await connect(page, HOST_PASSWORD)
    await openSettings(page)
    await page.getByRole("tab", { name: "Models" }).click()
    const search = page.getByRole("searchbox", { name: "Search models" })
    await expect(search).toBeVisible()
    await search.fill("fake")
    await expect(page.getByRole("switch", { name: "Fake Model" })).toBeVisible()
    await expect(page.getByRole("switch", { name: "Fake Model" })).toBeChecked()
  })

  test("the models catalog search shows its empty state for unknown models", async ({ page }) => {
    skipNarrow()
    await connect(page, HOST_PASSWORD)
    await openSettings(page)
    await page.getByRole("tab", { name: "Models" }).click()
    const search = page.getByRole("searchbox", { name: "Search models" })
    await expect(search).toBeVisible()
    await search.fill("no-such-model-xyz")
    await expect(
      page.getByRole("status", { name: 'No results for "no-such-model-xyz"' }),
    ).toBeVisible()
  })

  test("the packed Adaptive plugin is listed under Extensions > Plugins", async ({ page }) => {
    skipNarrow()
    await connect(page, HOST_PASSWORD)
    await openSettings(page)
    await page.getByRole("tab", { name: "Extensions" }).click()
    await page.getByRole("tab", { name: "Plugins" }).click()
    await expect(page.getByText("coool.adaptive").first()).toBeVisible()
  })

  test("the settings page renders at every viewport width", async ({ page }) => {
    await connect(page, HOST_PASSWORD)
    await openSettings(page)
    await expect(page.getByRole("button", { name: "Back to app" })).toBeVisible()
    await expect(page.getByRole("tabpanel")).toBeVisible()
  })
})

test.describe("plugin GUI mount limitation (2.2.5)", () => {
  test("no Adaptive settings surface mounts in the browser-served app", async ({ page }) => {
    test.skip(
      test.info().project.name === "chromium-narrow",
      "the tablist itself is collapsed at narrow width",
    )
    await connect(page, HOST_PASSWORD)
    await openSettings(page)
    // Limitation canary: the plugin registers a settings page and a command,
    // but the web app mounts plugin GUIs only through the desktop shell's
    // bridge. If a host upgrade starts mounting them, this fails and the
    // real settings journeys belong here (see TEST_STRATEGY §Web E2E).
    await expect(page.getByRole("tab", { name: "Adaptive" })).toHaveCount(0)
    await expect(page.getByText("OpenCode Adaptive")).toHaveCount(0)
  })
})

test.describe("plugin RPC integration", () => {
  test("settings read, patch, and reload persistence over the plugin RPC", async ({ page }) => {
    await connect(page, HOST_PASSWORD)
    const before = await rpc(page, "settings.get")
    expect(before["mode"]).toBe("observe")

    await rpc(page, "settings.set", { mode: "control" })
    await page.reload()
    const after = await rpc(page, "settings.get")
    expect(after["mode"]).toBe("control")

    await rpc(page, "settings.set", { mode: "observe" })
    expect((await rpc(page, "settings.get"))["mode"]).toBe("observe")
  })

  test("invalid patches are rejected by the schema gate from the browser", async ({ page }) => {
    await connect(page, HOST_PASSWORD)
    const result = await rpcRaw(page, "settings.set", { input: { mode: "sideways" } })
    expect(result.ok).toBe(true)
    const payload = result.body as { output?: { ok?: boolean; errors?: string[] } }
    expect(payload.output?.ok).toBe(false)
    expect(payload.output?.errors?.length ?? 0).toBeGreaterThan(0)
  })

  test("status mirrors the configured state", async ({ page }) => {
    await connect(page, HOST_PASSWORD)
    const status = await rpc(page, "status.get")
    expect(status["mode"]).toBe("observe")
    expect(status["tiers"]).toEqual({ quick: [], standard: [], advanced: [] })
    expect(status["receipts"]).toBe(0)
  })
})
