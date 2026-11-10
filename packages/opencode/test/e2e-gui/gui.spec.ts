// covers: ["ADP-033", "ADP-034", "ADP-035", "ADP-036", "ADP-054", "ADP-055"]
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { adaptiveRpc } from "../../src/rpc.js"
import type { StatusSnapshot } from "../../src/rpc.js"
import { rpc, startHost } from "../runtime-e2e/helpers.js"
import type { StartedHost } from "../runtime-e2e/helpers.js"
import { StandIn, interceptRpc, loadBuiltBundle, mountPage } from "./standin.js"
import type { GuiPlugin, Shown } from "./standin.js"
import type { FakeProviderScript } from "@coool/adaptive-testkit/fake-provider/scenarios"

const MODELS = { "fake-model": { name: "Fake Model" }, "fake-model-2": { name: "Fake Two" } }
const FAKE = { providerID: "fake", id: "fake-model" }
const FAKE_TWO = { providerID: "fake", id: "fake-model-2" }

const variants: [string, () => Promise<GuiPlugin>][] = [
  ["source", async () => (await import("../../src/gui.js")).default],
  ["built bundle", loadBuiltBundle],
]

/** Session state lives in the project's plugin instance: read it where the GUI writes it. */
const located = (host: StartedHost) => {
  const client = host.client.rpc(adaptiveRpc)
  const at = { location: { directory: host.project } }
  return {
    mode: async (sessionID: string) => ({
      mode: (await client["session-mode.get"]({ sessionID }, at)).mode,
    }),
    setMode: (sessionID: string, mode: "off" | "observe" | "active" | null) =>
      client["session-mode.set"]({ sessionID, mode }, at),
    tier: async (sessionID: string) => ({
      tier: (await client["tier-request.get"]({ sessionID }, at)).tier,
    }),
    setTier: (sessionID: string, tier: "quick" | "standard" | "advanced" | null) =>
      client["tier-request.set"]({ sessionID, tier }, at),
  }
}

/** A rejected call with the given reason, whatever its shape (hosts reject with plain objects too). */
const fail = (reason: unknown): Promise<never> =>
  new Promise((_, reject) => {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    reject(reason)
  })

const INVALID = { ok: false, errors: ["bad one", "bad two"] }

function modeSelect(container: HTMLElement): HTMLSelectElement {
  const element = container.querySelector<HTMLSelectElement>("select.adaptive-mode-select")
  if (element === null) throw new Error("mode select not rendered")
  return element
}

const EMPTY_TIERS = { quick: [], standard: [], advanced: [] }

/** Titles of the rows a select shows. */
const titles = (dialog: Shown): string[] => dialog.options.map((option) => option.title)

function hex(text: string): string {
  let out = ""
  for (const c of text) out += c.charCodeAt(0).toString(16).padStart(4, "0")
  return out
}

/** Plant receipts in the sandbox's plugin storage between two boots. */
function seedReceipts(home: string, receipts: readonly unknown[]): void {
  const now = Date.now()
  const value = JSON.stringify({ version: 1, receipts })
  const seeded = spawnSync(
    "sqlite3",
    [
      join(home, "data", "opencode", "opencode.db"),
      `INSERT OR REPLACE INTO kv (key, value, time_created, time_updated) VALUES ('plugin:${hex("coool.adaptive")}:coool.adaptive/receipts', '${value.replaceAll("'", "''")}', '${String(now)}', '${String(now)}')`,
    ],
    { encoding: "utf8" },
  )
  expect(seeded.status).toBe(0)
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** Every decision shape and outcome the receipts browser can render. */
function variedReceipts(now: number): unknown[] {
  const apply = (reason: string, at: number, extra: object = {}) => ({
    at,
    sessionID: "seed",
    tier: "standard",
    decision: {
      kind: "apply",
      model: FAKE,
      ...(reason === "pin" ? {} : { tier: "standard" }),
      reason,
      evidence: { skipped: [] },
    },
    ...extra,
  })
  const defer = (reason: string, at: number, detail?: string, extra: object = {}) => ({
    at,
    sessionID: "seed",
    decision: { kind: "defer", reason, ...(detail === undefined ? {} : { detail }) },
    ...extra,
  })
  const park = (reason: string, at: number, detail?: string) => ({
    at,
    sessionID: "seed",
    decision: { kind: "park", reason, ...(detail === undefined ? {} : { detail }) },
  })
  const list: object[] = [
    ...["pin", "preferred", "fallback", "probe", "draining"].map((reason, index) =>
      apply(reason, now - 30_000 - index * MINUTE, {
        outcome:
          index % 2 === 0
            ? { status: "succeeded" }
            : { status: "failed", category: "rate_limited" },
        unitID: "unit-1",
      }),
    ),
    {
      at: now - 3 * HOUR,
      sessionID: "seed",
      tier: "advanced",
      decision: {
        kind: "escalate",
        target: FAKE_TWO,
        step: "tier",
        tier: "advanced",
        evidence: [{ kind: "agent-request", detail: "needs more" }],
        budgetRemaining: 1,
      },
      outcome: { status: "interrupted", reason: "user" },
    },
    ...[
      "routing-defer",
      "adaptive-off",
      "pin-unverifiable",
      "pin-incompatible",
      "escalation-not-justified",
      "escalation-budget-exhausted",
      "escalation-ceiling",
      "escalation-no-candidate",
    ].map((reason, index) =>
      defer(reason, now - 2 * HOUR - index * MINUTE, index % 2 === 0 ? "why" : undefined),
    ),
    ...["all-blocked", "no-candidates", "no-compatible-resource", "pin-blocked"].map(
      (reason, index) =>
        park(reason, now - 5 * 24 * HOUR - index * MINUTE, index === 0 ? "wait" : undefined),
    ),
    {
      at: now - 10 * MINUTE,
      sessionID: "seed",
      decision: { kind: "observe-only", would: defer("routing-defer", now).decision },
    },
    {
      at: now - 11 * MINUTE,
      sessionID: "seed",
      decision: { kind: "observe-only", would: apply("preferred", now).decision },
    },
  ]
  // Plain filler up to well past one page.
  for (let index = 0; index < 12; index += 1)
    list.push(defer("routing-defer", now - 20 * MINUTE - index))
  return list.map((receipt, index) => ({ id: index + 1, ...receipt }))
}

describe.each(variants)("GUI /adaptive on a real host (%s)", (_name, load) => {
  let fresh: StartedHost
  let main: StartedHost
  let plugin: GuiPlugin
  let sessionID: string
  let pageHome: string
  let pageProject: string
  let seeded: StartedHost
  const sandboxes: string[] = []

  beforeAll(async () => {
    plugin = await load()
    fresh = await startHost({ models: MODELS })
    main = await startHost({ models: MODELS })
    sessionID = (await main.run({ text: "hello" })).sessionID
    const root = mkdtempSync(join(tmpdir(), "adaptive-gui-"))
    sandboxes.push(root)
    pageHome = join(root, "home")
    pageProject = join(root, "project")
    for (const dir of ["config", "data", "cache", "state"])
      mkdirSync(join(pageHome, dir), { recursive: true })
    mkdirSync(pageProject, { recursive: true })
    const first = await startHost({
      models: MODELS,
      paths: { home: pageHome, project: pageProject },
    })
    await first.close()
    seedReceipts(pageHome, variedReceipts(Date.now()))
    seeded = await startHost({ models: MODELS, paths: { home: pageHome, project: pageProject } })
    await rpc(seeded).settings.set({ inviteDismissed: true })
  })

  afterAll(async () => {
    await fresh.close()
    await main.close()
    await seeded.close()
    for (const root of sandboxes) rmSync(root, { recursive: true, force: true })
  })

  beforeEach(async () => {
    const host = rpc(main)
    await host.settings.set({
      mode: "observe",
      tiers: EMPTY_TIERS,
      pin: null,
      inviteDismissed: true,
    })
    await located(main).setMode(sessionID, null)
    await located(main).setTier(sessionID, null)
  })

  const installed: StandIn[] = []
  afterEach(() => {
    for (const gui of installed.splice(0)) gui.dispose()
  })

  const installOn = (host: StartedHost, options: ConstructorParameters<typeof StandIn>[1] = {}) => {
    const gui = new StandIn(host, options)
    installed.push(gui)
    return { gui, ...gui.install(plugin) }
  }

  it("registers /adaptive and the settings page", () => {
    const { command, page } = installOn(main)
    expect(command.slash).toEqual({ name: "adaptive" })
    expect(command.suggested).toBe(true)
    expect(page.id).toBe("adaptive")
  })

  describe("first run", () => {
    it("invites once, opens the menu on request, and remembers it was shown", async () => {
      await rpc(fresh).settings.set({ inviteDismissed: false })
      const { gui, command } = installOn(fresh)
      gui.open(command)
      const invite = await gui.next("OpenCode Adaptive")
      expect(invite.kind).toBe("confirm")
      expect(invite.description).toContain("Observe mode")
      invite.answer(true)
      const pick = await gui.next("OpenCode Adaptive")
      expect(titles(pick)).toEqual(["Open the menu now", "Later"])
      pick.choose("Open the menu now")
      const menu = await gui.next("Adaptive (observe)")
      expect(titles(menu)).toEqual([
        "Status",
        "Models",
        "Mode",
        "Tier",
        "Pin",
        "Receipts",
        "Health",
        "Parked work",
        "Doctor",
      ])
      menu.dismiss()
      await gui.finished()
      expect(gui.toasts).toEqual([{ title: "Settings saved", variant: "success" }])
      expect(await rpc(fresh).settings.get()).toMatchObject({ inviteDismissed: true })
    })

    it("lets the user say Later and skips the invite from then on", async () => {
      await rpc(fresh).settings.set({ inviteDismissed: false })
      const { gui, command } = installOn(fresh)
      gui.open(command)
      ;(await gui.next("OpenCode Adaptive")).dismiss()
      ;(await gui.next("OpenCode Adaptive")).choose("Later")
      await gui.finished()
      expect(await rpc(fresh).settings.get()).toMatchObject({ inviteDismissed: true })

      const again = installOn(fresh)
      again.gui.open(again.command)
      ;(await again.gui.next("Adaptive (observe)")).dismiss()
      await again.gui.finished()
      expect(again.gui.toasts).toEqual([])
    })
  })

  describe("status, pin and receipts on an unconfigured host", () => {
    it("explains an empty status, pin list and receipt history", async () => {
      const { gui, command } = installOn(fresh)
      gui.open(command)
      let menu = await gui.next("Adaptive (observe)")
      expect(menu.options[0]?.description).toBe("no models configured yet")
      menu.choose("Status")
      const status = await gui.next("Status")
      expect(status.kind).toBe("alert")
      status.ok()
      menu = await gui.next("Adaptive (observe)")
      menu.choose("Pin")
      const pin = await gui.next("Pin")
      expect(pin.description).toBe("(no configured resources to pin)")
      pin.ok()
      ;(await gui.next("Adaptive (observe)")).choose("Receipts")
      const receipts = await gui.next("Receipts")
      expect(receipts.description).toBe("No decisions recorded yet.")
      receipts.ok()
      ;(await gui.next("Adaptive (observe)")).dismiss()
      await gui.finished()
    })
  })

  describe("models editor", () => {
    it("adds, orders and removes resources, and every step persists on the server", async () => {
      const { gui, command } = installOn(main)
      gui.open(command)
      ;(await gui.next("Adaptive (observe)")).choose("Models")
      const tiers = await gui.next("Tier")
      expect(titles(tiers)).toEqual(["quick (0)", "standard (0)", "advanced (0)"])
      tiers.choose("quick (0)")
      let page = await gui.next("Tier: quick")
      expect(titles(page)).toEqual(["Add model…"])
      page.choose("Add model…")

      // Add a model with a variant.
      let picker = await gui.next("Add model")
      expect(picker.placeholder).toBe("Search provider / model / name")
      expect(titles(picker)).toContain("fake/fake-model")
      picker.choose("fake/fake-model")
      const variant = await gui.next("Variant: fake/fake-model")
      expect(titles(variant)).toEqual(["(model default)", "@low", "@medium", "@high"])
      variant.choose("@low")

      // Add a second model on its default variant.
      page = await gui.next("Tier: quick")
      expect(titles(page)).toHaveLength(2)
      page.choose("Add model…")
      picker = await gui.next("Add model")
      picker.choose("fake/fake-model-2")
      ;(await gui.next("Variant: fake/fake-model-2")).choose("(model default)")

      // A model with no variants skips the variant step.
      page = await gui.next("Tier: quick")
      page.choose("Add model…")
      ;(await gui.next("Add model")).choose("opencode/big-pickle")

      page = await gui.next("Tier: quick")
      expect(titles(page)).toHaveLength(4)
      const labels = titles(page).slice(1)
      expect(await rpc(main).settings.get()).toMatchObject({
        tiers: {
          quick: [
            { providerID: "fake", id: "fake-model", variant: "low" },
            FAKE_TWO,
            { providerID: "opencode", id: "big-pickle" },
          ],
        },
      })

      // Move the last resource to the top, then down and up again.
      page.choose(labels[2] ?? "")
      let resource = await gui.next(`Resource: ${(labels[2] ?? "").split(" [")[0] ?? ""}`)
      expect(titles(resource)).toEqual(["Move to top", "Move up", "Move down", "Remove"])
      resource.choose("Move to top")
      page = await gui.next("Tier: quick")
      expect(await rpc(main).settings.get()).toMatchObject({
        tiers: { quick: [{ id: "big-pickle" }, { id: "fake-model" }, { id: "fake-model-2" }] },
      })
      page.choose(titles(page)[2] ?? "")
      resource = await gui.next(/^Resource: /)
      resource.choose("Move up")
      page = await gui.next("Tier: quick")
      page.choose(titles(page)[2] ?? "")
      resource = await gui.next(/^Resource: /)
      resource.choose("Move down")
      page = await gui.next("Tier: quick")
      expect(await rpc(main).settings.get()).toMatchObject({
        tiers: { quick: [{ id: "fake-model" }, { id: "fake-model-2" }, { id: "big-pickle" }] },
      })

      // Cancelling a removal keeps the resource; confirming drops it.
      page.choose(titles(page)[1] ?? "")
      resource = await gui.next(/^Resource: /)
      resource.choose("Remove")
      const keep = await gui.next("Remove resource")
      expect(keep.kind).toBe("confirm")
      expect(keep.description).toMatch(/^Remove .+ from quick\?$/)
      keep.answer(false)
      page = await gui.next("Tier: quick")
      expect(titles(page)).toHaveLength(4)
      page.choose(titles(page)[1] ?? "")
      ;(await gui.next(/^Resource: /)).choose("Remove")
      ;(await gui.next("Remove resource")).answer(true)
      page = await gui.next("Tier: quick")
      expect(titles(page)).toHaveLength(3)

      // Escape unwinds the editor one level at a time.
      page.dismiss()
      ;(await gui.next("Tier")).dismiss()
      ;(await gui.next("Adaptive (observe)")).dismiss()
      await gui.finished()
      expect(gui.toasts).toEqual([{ title: "Settings saved", variant: "success" }])
    })

    it("backs out of the model picker and the variant step without saving", async () => {
      const { gui, command } = installOn(main)
      gui.open(command)
      ;(await gui.next("Adaptive (observe)")).choose("Models")
      ;(await gui.next("Tier")).choose("standard (0)")
      ;(await gui.next("Tier: standard")).choose("Add model…")
      ;(await gui.next("Add model")).dismiss()
      ;(await gui.next("Tier: standard")).choose("Add model…")
      ;(await gui.next("Add model")).choose("fake/fake-model")
      ;(await gui.next("Variant: fake/fake-model")).dismiss()
      ;(await gui.next("Tier: standard")).choose("Add model…")
      ;(await gui.next("Add model")).dismiss()
      ;(await gui.next("Tier: standard")).dismiss()
      ;(await gui.next("Tier")).dismiss()
      ;(await gui.next("Adaptive (observe)")).dismiss()
      await gui.finished()
      expect(await rpc(main).settings.get()).toMatchObject({ tiers: EMPTY_TIERS })
      expect(gui.toasts).toEqual([])
    })

    it("backs out of a resource menu without changing the order", async () => {
      await rpc(main).settings.set({ tiers: { ...EMPTY_TIERS, advanced: [FAKE] } })
      const { gui, command } = installOn(main)
      gui.open(command)
      ;(await gui.next("Adaptive (observe)")).choose("Models")
      ;(await gui.next("Tier")).choose("advanced (1)")
      const page = await gui.next("Tier: advanced")
      page.choose(titles(page)[1] ?? "")
      ;(await gui.next(/^Resource: /)).dismiss()
      ;(await gui.next("Tier: advanced")).dismiss()
      ;(await gui.next("Tier")).dismiss()
      ;(await gui.next("Adaptive (observe)")).dismiss()
      await gui.finished()
    })
  })

  describe("status table", () => {
    it("shows configured resources and closes with the button or Escape", async () => {
      await rpc(main).settings.set({
        tiers: { ...EMPTY_TIERS, quick: [FAKE], advanced: [FAKE_TWO] },
      })
      const { gui, command } = installOn(main)
      gui.open(command)
      let menu = await gui.next("Adaptive (observe)")
      expect(menu.options[0]?.description).toBe("2 resources")
      menu.choose("Status")
      let table = await gui.next("Status")
      expect(table.kind).toBe("custom")
      expect(table.text()).toContain("fake/fake-model")
      expect(table.text()).toContain("fake/fake-model-2")
      table.press("Close")
      menu = await gui.next("Adaptive (observe)")
      menu.choose("Status")
      table = await gui.next("Status")
      table.escape()
      ;(await gui.next("Adaptive (observe)")).dismiss()
      await gui.finished()
    })
  })

  describe("operating mode", () => {
    it("switches the global mode and persists it", async () => {
      const { gui, command } = installOn(main)
      gui.open(command)
      ;(await gui.next("Adaptive (observe)")).choose("Mode")
      const target = await gui.next("Operating mode")
      expect(titles(target)).toEqual(["Global mode…", "This session…"])
      target.choose("Global mode…")
      const global = await gui.next("Global mode")
      expect(titles(global)).toEqual(["off", "observe (current)", "active"])
      global.choose("active")
      const menu = await gui.next("Adaptive (active)")
      menu.choose("Mode")
      ;(await gui.next("Operating mode")).choose("Global mode…")
      ;(await gui.next("Global mode")).choose("active (current)")
      ;(await gui.next("Adaptive (active)")).choose("Mode")
      ;(await gui.next("Operating mode")).choose("Global mode…")
      ;(await gui.next("Global mode")).dismiss()
      ;(await gui.next("Adaptive (active)")).dismiss()
      await gui.finished()
      expect(await rpc(main).settings.get()).toMatchObject({ mode: "active" })
      expect(gui.toasts).toEqual([{ title: "Settings saved", variant: "success" }])
    })

    it("explains that a session override needs a session when on Home", async () => {
      const { gui, command } = installOn(main)
      gui.open(command)
      ;(await gui.next("Adaptive (observe)")).choose("Mode")
      ;(await gui.next("Operating mode")).choose("This session…")
      const alert = await gui.next("This session")
      expect(alert.description).toContain("inside a session")
      alert.ok()
      ;(await gui.next("Operating mode")).dismiss()
      ;(await gui.next("Adaptive (observe)")).dismiss()
      await gui.finished()
    })

    it("sets and clears a per-session override inside a session", async () => {
      const { gui, command } = installOn(main, { session: { id: sessionID } })
      gui.open(command)
      let menu = await gui.next("Adaptive (observe)")
      menu.choose("Mode")
      ;(await gui.next("Operating mode")).choose("This session…")
      let session = await gui.next("This session's mode")
      expect(titles(session)).toEqual([
        "Follow global (observe)",
        "off",
        "observe (current)",
        "active",
      ])
      // Following global with no override changes nothing.
      session.choose("Follow global (observe)")
      menu = await gui.next("Adaptive (observe)")
      expect(await located(main).mode(sessionID)).toEqual({ mode: null })
      // The effective mode picked again is a no-op.
      menu.choose("Mode")
      ;(await gui.next("Operating mode")).choose("This session…")
      ;(await gui.next("This session's mode")).choose("observe (current)")
      // An override changes the session only.
      menu = await gui.next("Adaptive (observe)")
      menu.choose("Mode")
      ;(await gui.next("Operating mode")).choose("This session…")
      ;(await gui.next("This session's mode")).choose("active")
      menu = await gui.next("Adaptive (active)")
      expect(await located(main).mode(sessionID)).toEqual({ mode: "active" })
      expect(await rpc(main).settings.get()).toMatchObject({ mode: "observe" })
      // Picking the override again is a no-op; following global clears it.
      menu.choose("Mode")
      ;(await gui.next("Operating mode")).choose("This session…")
      session = await gui.next("This session's mode")
      expect(titles(session)).toContain("active (override)")
      session.choose("active (override)")
      ;(await gui.next("Adaptive (active)")).choose("Mode")
      ;(await gui.next("Operating mode")).choose("This session…")
      ;(await gui.next("This session's mode")).choose("Follow global (observe)")
      menu = await gui.next("Adaptive (observe)")
      expect(await located(main).mode(sessionID)).toEqual({ mode: null })
      // Escape leaves the session menu.
      menu.choose("Mode")
      ;(await gui.next("Operating mode")).choose("This session…")
      ;(await gui.next("This session's mode")).dismiss()
      ;(await gui.next("Adaptive (observe)")).dismiss()
      await gui.finished()
    })
  })

  describe("tier request", () => {
    it("explains that a tier request needs a session when on Home", async () => {
      const { gui, command } = installOn(main)
      gui.open(command)
      const menu = await gui.next("Adaptive (observe)")
      expect(menu.options[3]?.description).toBe("pin a tier for the current session")
      menu.choose("Tier")
      const alert = await gui.next("This session")
      expect(alert.description).toContain("tier request")
      alert.ok()
      ;(await gui.next("Adaptive (observe)")).dismiss()
      await gui.finished()
    })

    it("pins and clears a tier for the session", async () => {
      const { gui, command } = installOn(main, { session: { id: sessionID } })
      gui.open(command)
      let menu = await gui.next("Adaptive (observe)")
      expect(menu.options[3]?.description).toBe("not pinned — the routing ladder decides")
      menu.choose("Tier")
      let tier = await gui.next("This session's tier")
      expect(titles(tier)).toEqual(["Follow routing ladder", "quick", "standard", "advanced"])
      tier.choose("Follow routing ladder")
      menu = await gui.next("Adaptive (observe)")
      menu.choose("Tier")
      ;(await gui.next("This session's tier")).choose("quick")
      menu = await gui.next("Adaptive (observe)")
      expect(menu.options[3]?.description).toBe("pinned to quick — steers this session")
      expect(await located(main).tier(sessionID)).toEqual({ tier: "quick" })
      menu.choose("Tier")
      tier = await gui.next("This session's tier")
      expect(titles(tier)).toContain("quick (pinned)")
      tier.choose("quick (pinned)")
      ;(await gui.next("Adaptive (observe)")).choose("Tier")
      ;(await gui.next("This session's tier")).choose("Follow routing ladder")
      menu = await gui.next("Adaptive (observe)")
      expect(await located(main).tier(sessionID)).toEqual({ tier: null })
      menu.choose("Tier")
      ;(await gui.next("This session's tier")).dismiss()
      ;(await gui.next("Adaptive (observe)")).dismiss()
      await gui.finished()
    })
  })

  describe("pin", () => {
    it("pins one configured resource and clears it again", async () => {
      await rpc(main).settings.set({
        tiers: { ...EMPTY_TIERS, quick: [FAKE], standard: [FAKE_TWO] },
      })
      const { gui, command } = installOn(main)
      gui.open(command)
      let menu = await gui.next("Adaptive (observe)")
      expect(menu.options[4]?.description).toBe("force one resource")
      menu.choose("Pin")
      let pin = await gui.next("Pin")
      expect(titles(pin)).toEqual([
        "No pin",
        "fake/fake-model (quick)",
        "fake/fake-model-2 (standard)",
      ])
      pin.choose("fake/fake-model-2 (standard)")
      menu = await gui.next("Adaptive (observe)")
      expect(menu.options[4]?.description).toBe("pinned to fake/fake-model-2")
      expect(await rpc(main).settings.get()).toMatchObject({ pin: FAKE_TWO })
      menu.choose("Pin")
      pin = await gui.next("Pin")
      pin.choose("No pin")
      ;(await gui.next("Adaptive (observe)")).choose("Pin")
      ;(await gui.next("Pin")).dismiss()
      ;(await gui.next("Adaptive (observe)")).dismiss()
      await gui.finished()
      expect(await rpc(main).settings.get()).toMatchObject({ pin: null })
    })
  })

  describe("receipts", () => {
    it("shows the decision a real turn recorded, with its explanation", async () => {
      const { gui, command } = installOn(main)
      gui.open(command)
      ;(await gui.next("Adaptive (observe)")).choose("Receipts")
      const list = await gui.next(/^Receipts \(\d+, newest first\)$/)
      expect(list.kind).toBe("select")
      const row = list.options[0]
      expect(row?.title).toMatch(/^#\d+ /)
      list.choose(row?.title ?? "")
      const detail = await gui.next(/^Receipt #\d+$/)
      expect(detail.kind).toBe("alert")
      expect(detail.description).toContain("What happened:")
      detail.ok()
      ;(await gui.next(/^Receipts /)).dismiss()
      ;(await gui.next("Adaptive (observe)")).dismiss()
      await gui.finished()
    })

    it("pages through more receipts than one page and opens every kind", async () => {
      const { gui, command } = installOn(seeded)
      gui.open(command)
      ;(await gui.next("Adaptive (observe)")).choose("Receipts")
      const total = variedReceipts(Date.now()).length
      let list = await gui.next(`Receipts (${String(total)}, newest first)`)
      expect(titles(list).filter((title) => title.startsWith("#"))).toHaveLength(20)
      expect(titles(list).slice(-1)).toEqual(["Next page"])
      // Open each receipt of the first page: every decision/outcome wording renders.
      const first = titles(list).filter((title) => title.startsWith("#"))
      list.choose(first[0] ?? "")
      for (const [index, title] of first.entries()) {
        if (index > 0) {
          list = await gui.next(/^Receipts /)
          list.choose(title)
        }
        const detail = await gui.next(/^Receipt #\d+$/)
        expect(detail.description).toContain("What happened:")
        detail.ok()
      }
      list = await gui.next(/^Receipts /)
      list.choose("Next page")
      list = await gui.next(/^Receipts /)
      const second = titles(list)
      expect(second).toContain("Previous page")
      expect(second).not.toContain("Next page")
      const rows = second.filter((title) => title.startsWith("#"))
      expect(rows).toHaveLength(total - 20)
      for (const [index, title] of rows.entries()) {
        if (index > 0) list = await gui.next(/^Receipts /)
        list.choose(title)
        ;(await gui.next(/^Receipt #\d+$/)).ok()
      }
      list = await gui.next(/^Receipts /)
      list.choose("Previous page")
      list = await gui.next(/^Receipts /)
      expect(titles(list).slice(-1)).toEqual(["Next page"])
      list.dismiss()
      ;(await gui.next("Adaptive (observe)")).dismiss()
      await gui.finished()
    })
  })

  describe("settings page", () => {
    it("shows status, changes the mode through the server and lists receipts", async () => {
      const { page } = installOn(main)
      const { container, dispose } = mountPage(page)
      try {
        const select = await vi.waitFor(() => {
          const element = modeSelect(container)
          expect(element.disabled).toBe(false)
          return element
        })
        expect(container.querySelectorAll(".adaptive-receipt-line").length).toBeGreaterThan(0)
        expect(select.value).toBe("observe")
        select.value = "active"
        select.dispatchEvent(new Event("change", { bubbles: true }))
        await vi.waitFor(() => {
          expect(container.querySelector(".adaptive-saved")?.textContent).toBe("Saved")
        })
        expect(await rpc(main).settings.get()).toMatchObject({ mode: "active" })
        // A change made elsewhere reaches the open page through the event stream.
        await rpc(main).settings.set({ mode: "off" })
        await vi.waitFor(() => {
          expect(
            container.querySelector<HTMLSelectElement>("select.adaptive-mode-select")?.value,
          ).toBe("off")
        })
      } finally {
        dispose()
      }
    })
  })

  describe("settings page in a session", () => {
    it("reads the server through the session's location", async () => {
      const { page } = installOn(main, { session: { id: sessionID } })
      const { container, dispose } = mountPage(page)
      try {
        await vi.waitFor(() => {
          expect(modeSelect(container).disabled).toBe(false)
        })
        expect(container.querySelectorAll(".adaptive-receipt-line").length).toBeGreaterThan(0)
      } finally {
        dispose()
      }
    })
  })

  describe("rejected writes", () => {
    it("alerts when the server refuses a global mode", async () => {
      const client = interceptRpc(main.client, (method, call) =>
        method === "settings.set" ? Promise.resolve(INVALID) : call(),
      )
      const { gui, command } = installOn(main, { client })
      gui.open(command)
      ;(await gui.next("Adaptive (observe)")).choose("Mode")
      ;(await gui.next("Operating mode")).choose("Global mode…")
      ;(await gui.next("Global mode")).choose("active")
      const alert = await gui.next("Invalid settings")
      expect(alert.description).toBe("bad one; bad two")
      alert.ok()
      ;(await gui.next("Adaptive (observe)")).dismiss()
      await gui.finished()
      expect(await rpc(main).settings.get()).toMatchObject({ mode: "observe" })
      expect(gui.toasts).toEqual([])
    })

    it("alerts when the server refuses a session mode, set or cleared", async () => {
      const client = interceptRpc(main.client, (method, call) =>
        method === "session-mode.set" ? Promise.resolve(INVALID) : call(),
      )
      const { gui, command } = installOn(main, { client, session: { id: sessionID } })
      gui.open(command)
      ;(await gui.next("Adaptive (observe)")).choose("Mode")
      ;(await gui.next("Operating mode")).choose("This session…")
      ;(await gui.next("This session's mode")).choose("active")
      ;(await gui.next("Invalid settings")).ok()
      ;(await gui.next("Adaptive (observe)")).dismiss()
      await gui.finished()

      await located(main).setMode(sessionID, "active")
      const again = installOn(main, { client, session: { id: sessionID } })
      again.gui.open(again.command)
      ;(await again.gui.next("Adaptive (active)")).choose("Mode")
      ;(await again.gui.next("Operating mode")).choose("This session…")
      ;(await again.gui.next("This session's mode")).choose("Follow global (observe)")
      ;(await again.gui.next("Invalid settings")).ok()
      ;(await again.gui.next("Adaptive (active)")).dismiss()
      await again.gui.finished()
      expect(await located(main).mode(sessionID)).toEqual({ mode: "active" })
    })

    it("alerts when the server refuses a tier request", async () => {
      const client = interceptRpc(main.client, (method, call) =>
        method === "tier-request.set" ? Promise.resolve(INVALID) : call(),
      )
      const { gui, command } = installOn(main, { client, session: { id: sessionID } })
      gui.open(command)
      ;(await gui.next("Adaptive (observe)")).choose("Tier")
      ;(await gui.next("This session's tier")).choose("quick")
      const alert = await gui.next("Invalid tier request")
      expect(alert.description).toBe("bad one; bad two")
      alert.ok()
      ;(await gui.next("Adaptive (observe)")).dismiss()
      await gui.finished()
      expect(await located(main).tier(sessionID)).toEqual({ tier: null })
    })

    it("toasts when a session-mode or tier-request write cannot be sent", async () => {
      const client = interceptRpc(main.client, (method, call) =>
        method === "session-mode.set" || method === "tier-request.set"
          ? fail(new Error(`${method} refused`))
          : call(),
      )
      const { gui, command } = installOn(main, { client, session: { id: sessionID } })
      gui.open(command)
      ;(await gui.next("Adaptive (observe)")).choose("Mode")
      ;(await gui.next("Operating mode")).choose("This session…")
      ;(await gui.next("This session's mode")).choose("active")
      ;(await gui.next("Adaptive (observe)")).choose("Tier")
      ;(await gui.next("This session's tier")).choose("quick")
      ;(await gui.next("Adaptive (observe)")).dismiss()
      await gui.finished()
      expect(gui.toasts).toEqual([
        { title: "session-mode.set refused", variant: "error" },
        { title: "tier-request.set refused", variant: "error" },
      ])
    })

    it("still opens the menu when remembering the invitation fails", async () => {
      await rpc(main).settings.set({ inviteDismissed: false })
      const client = interceptRpc(main.client, (method, call) =>
        method === "settings.set" ? fail({ message: "plain failure" }) : call(),
      )
      const { gui, command } = installOn(main, { client })
      gui.open(command)
      ;(await gui.next("OpenCode Adaptive")).answer(true)
      ;(await gui.next("OpenCode Adaptive")).choose("Open the menu now")
      ;(await gui.next("Adaptive (observe)")).dismiss()
      await gui.finished()
      expect(gui.toasts).toEqual([{ title: "plain failure", variant: "error" }])
    })
  })

  describe("failing reads", () => {
    it("keeps the menu usable and toasts each failure in its own words", async () => {
      let settingsReads = 0
      const client = interceptRpc(main.client, (method, call) => {
        switch (method) {
          case "status.get":
            return fail({ message: "status down" })
          case "tier-request.get":
            return fail({ type: "rpc.timeout", retries: 1n })
          case "settings.get":
            settingsReads += 1
            return settingsReads === 1 ? call() : fail("settings gone")
          case "receipts.list":
            return fail(42)
          default:
            return call()
        }
      })
      const { gui, command } = installOn(main, { client, session: { id: sessionID } })
      gui.open(command)
      let menu = await gui.next("Adaptive (observe)")
      expect(menu.options[0]?.description).toBe("how every configured model is doing")
      expect(menu.options[3]?.description).toBe("pin a tier for the current session")
      menu.choose("Status")
      menu = await gui.next("Adaptive (observe)")
      menu.choose("Tier")
      menu = await gui.next("Adaptive (observe)")
      menu.choose("Models")
      menu = await gui.next("Adaptive (observe)")
      menu.choose("Receipts")
      ;(await gui.next("Adaptive (observe)")).dismiss()
      await gui.finished()
      expect(gui.toasts).toEqual([
        { title: "status down", variant: "error" },
        { title: '{"type":"rpc.timeout","retries":"1"}', variant: "error" },
        { title: "settings gone", variant: "error" },
        { title: "42", variant: "error" },
      ])
    })

    it("closes the tier editor when the status cannot be read", async () => {
      const client = interceptRpc(main.client, (method, call) =>
        method === "status.get" ? fail(new Error("no status")) : call(),
      )
      const { gui, command } = installOn(main, { client })
      gui.open(command)
      ;(await gui.next("Adaptive (observe)")).choose("Models")
      ;(await gui.next("Adaptive (observe)")).dismiss()
      await gui.finished()
      expect(gui.toasts).toEqual([{ title: "no status", variant: "error" }])
    })

    it("keeps the tier page and its last saved rows when a refresh fails", async () => {
      await rpc(main).settings.set({ tiers: { ...EMPTY_TIERS, quick: [FAKE] } })
      let broken = false
      const client = interceptRpc(main.client, (method, call) =>
        broken && (method === "settings.get" || method === "status.get")
          ? fail(new Error("down"))
          : call(),
      )
      const { gui, command } = installOn(main, { client })
      gui.open(command)
      ;(await gui.next("Adaptive (observe)")).choose("Models")
      ;(await gui.next("Tier")).choose("quick (1)")
      let page = await gui.next("Tier: quick")
      broken = true
      page.choose(titles(page)[1] ?? "")
      // Moving the only resource is a no-op that still saves.
      ;(await gui.next(/^Resource: /)).choose("Move up")
      page = await gui.next("Tier: quick")
      expect(titles(page)).toHaveLength(2)
      page.choose("Add model…")
      ;(await gui.next("Add model")).choose("opencode/big-pickle")
      page = await gui.next("Tier: quick")
      expect(titles(page)).toHaveLength(3)
      page.choose(titles(page)[2] ?? "")
      ;(await gui.next(/^Resource: /)).choose("Move down")
      page = await gui.next("Tier: quick")
      broken = false
      page.dismiss()
      ;(await gui.next("Tier")).dismiss()
      ;(await gui.next("Adaptive (observe)")).dismiss()
      await gui.finished()
      expect(gui.toasts).toEqual([{ title: "Settings saved", variant: "success" }])
      expect(await rpc(main).settings.get()).toMatchObject({
        tiers: { quick: [{ id: "fake-model" }, { id: "big-pickle" }] },
      })
    })
  })

  describe("model catalog", () => {
    it.each([
      ["fails to load", { catalogFails: true }],
      ["has no server", { noServer: true }],
    ])("offers an empty picker when the catalog %s", async (_label, options) => {
      const { gui, command } = installOn(main, options)
      gui.open(command)
      ;(await gui.next("Adaptive (observe)")).choose("Models")
      ;(await gui.next("Tier")).choose("standard (0)")
      ;(await gui.next("Tier: standard")).choose("Add model…")
      const picker = await gui.next("Add model")
      expect(picker.options).toEqual([])
      picker.dismiss()
      ;(await gui.next("Tier: standard")).dismiss()
      ;(await gui.next("Tier")).dismiss()
      ;(await gui.next("Adaptive (observe)")).dismiss()
      await gui.finished()
    })

    it("toasts when the flow itself breaks", async () => {
      let armed = false
      const client = new Proxy(main.client, {
        get(target, property) {
          if (armed && property === "rpc") {
            return () => {
              throw new Error("host went away")
            }
          }
          return Reflect.get(target, property) as unknown
        },
      })
      const { gui, command } = installOn(main, { client })
      armed = true
      gui.open(command)
      await gui.finished()
      expect(gui.toasts).toEqual([{ title: "host went away", variant: "error" }])
    })
  })

  describe("resources in trouble", () => {
    it("shows health, windows, breakers and the pin in every view", async () => {
      await rpc(main).settings.set({
        tiers: {
          ...EMPTY_TIERS,
          quick: [FAKE, FAKE_TWO, { providerID: "opencode", id: "big-pickle" }],
        },
        pin: FAKE,
      })
      const now = Date.now()
      const client = interceptRpc(main.client, async (method, call) => {
        const out = await call()
        if (method !== "status.get") return out
        const snapshot = out as StatusSnapshot
        const [first, second, third] = snapshot.tiers.quick
        if (first === undefined || second === undefined || third === undefined) return out
        return {
          ...snapshot,
          tiers: {
            ...snapshot.tiers,
            quick: [
              {
                ...first,
                health: "rate_limited" as const,
                windowed: true,
                windowUntil: null,
                usedPercent: 80,
                resetAt: null,
              },
              {
                ...second,
                breaker: "open" as const,
                windowed: true,
                windowUntil: now + HOUR,
                usedPercent: 50,
                resetAt: now + 2 * HOUR,
              },
              { ...third, breaker: "half_open" as const },
            ],
          },
        }
      })
      const { gui, command, page } = installOn(main, { client })
      gui.open(command)
      let menu = await gui.next("Adaptive (observe)")
      expect(menu.options[0]?.description).toBe("3 resources · 2 windowed")
      menu.choose("Status")
      const table = await gui.next("Status")
      const text = table.text()
      expect(text).toContain("rate_limited")
      expect(text).toContain("windowed (deadline unknown)")
      expect(text).toContain("used 80%")
      expect(text).toContain("breaker open")
      expect(text).toMatch(/resets \d{4}-\d{2}-\d{2} \d{2}:\d{2}/)
      expect(text).toContain("probing")
      expect(text).toContain("(pinned)")
      table.press("Close")
      menu = await gui.next("Adaptive (observe)")
      menu.choose("Models")
      ;(await gui.next("Tier")).choose("quick (3)")
      const tier = await gui.next("Tier: quick")
      expect(titles(tier).slice(1)).toEqual([
        "fake/fake-model [rate_limited, windowed]",
        "fake/fake-model-2 [breaker-open, windowed]",
        "opencode/big-pickle [half-open]",
      ])
      tier.dismiss()
      ;(await gui.next("Tier")).dismiss()
      ;(await gui.next("Adaptive (observe)")).dismiss()
      await gui.finished()

      const { container, dispose } = mountPage(page)
      try {
        await vi.waitFor(() => {
          expect(container.textContent).toContain("fake/fake-model [rate_limited, windowed]")
        })
        const rows = [...container.querySelectorAll(".adaptive-row")].map((row) => row.textContent)
        expect(rows).toContain("Pinfake/fake-model")
        expect(rows.join("\n")).toContain("opencode/big-pickle [half-open]")
      } finally {
        dispose()
      }
    })
  })

  describe("settings page under failure", () => {
    it("shows the disconnected row when the server stops answering", async () => {
      let gone = false
      const client = interceptRpc(main.client, (method, call) =>
        gone && (method === "status.get" || method === "receipts.list")
          ? fail(new Error("gone"))
          : call(),
      )
      const { page } = installOn(main, { client })
      const { container, dispose } = mountPage(page)
      try {
        await vi.waitFor(() => {
          expect(container.querySelectorAll(".adaptive-receipt-line").length).toBeGreaterThan(0)
        })
        gone = true
        await rpc(main).settings.set({ mode: "active" })
        await vi.waitFor(() => {
          expect(container.querySelector(".adaptive-row-value")?.textContent).toBe("disconnected")
          expect(container.querySelectorAll(".adaptive-receipt-line")).toHaveLength(0)
        })
      } finally {
        dispose()
      }
    })

    it("does not claim a save that failed and ignores a value it cannot parse", async () => {
      let statusReads = 0
      const client = interceptRpc(main.client, (method, call) => {
        if (method === "settings.set") return fail({ message: "refused" })
        if (method === "status.get") statusReads += 1
        return call()
      })
      const { page } = installOn(main, { client })
      const { container, dispose } = mountPage(page)
      try {
        const select = await vi.waitFor(() => {
          const element = modeSelect(container)
          expect(element.disabled).toBe(false)
          return element
        })
        // The page and the waiting pill both read status; count from here on.
        const before = statusReads
        select.value = "bogus"
        select.dispatchEvent(new Event("change", { bubbles: true }))
        expect(statusReads).toBe(before)
        select.value = "active"
        select.dispatchEvent(new Event("change", { bubbles: true }))
        await vi.waitFor(() => {
          expect(statusReads).toBe(before + 1)
        })
        expect(container.querySelector(".adaptive-saved")).toBeNull()
        expect(select.value).toBe("observe")
      } finally {
        dispose()
      }
    })
  })

  describe("waiting pill", () => {
    const THREE = { providerID: "fake", id: "fake-model-3" }
    const quotaFor = (seconds: number): FakeProviderScript => ({
      behaviors: [
        {
          status: 429,
          headers: { "retry-after": String(seconds) },
          body: JSON.stringify({
            error: { message: "You exceeded your current quota", type: "insufficient_quota" },
          }),
        },
      ],
    })
    const unauthorized: FakeProviderScript = {
      behaviors: [
        {
          status: 401,
          body: JSON.stringify({
            error: { message: "invalid api key", type: "invalid_request_error" },
          }),
        },
      ],
    }

    it("marks a session parked until quota returns, with when it resumes", async () => {
      const host = await startHost({
        models: { ...MODELS, "fake-model-3": { name: "Fake Three" } },
      })
      // Settings go to the project's plugin instance: it runs the sessions and serves the GUI.
      const project = host.client.rpc(adaptiveRpc)
      const at = { location: { directory: host.project } }
      const reads = async (): Promise<StatusSnapshot> => project["status.get"](undefined, at)
      // The host also runs an unlocated instance that handles session events;
      // settings are per-instance memory, so both get the same patch.
      const settle = async (patch: Record<string, unknown>): Promise<void> => {
        await rpc(host).settings.set(patch)
        await project["settings.set"](patch, at)
      }
      try {
        await settle({
          mode: "active",
          tiers: { quick: [THREE], standard: [FAKE, FAKE_TWO], advanced: [] },
          inviteDismissed: true,
        })
        // Three days of quota: the session stays parked for the whole test.
        const exhausted = quotaFor(3 * 24 * 3600)
        host.provider.setModelScripts({
          "fake-model": exhausted,
          "fake-model-2": exhausted,
          "fake-model-3": unauthorized,
        })
        const session = await host.client.session.create()
        await host.client.session.prompt({ sessionID: session.id, text: "finish this" })
        const parked = await vi.waitFor(
          async () => {
            const snap = await reads()
            const entry = snap.waiting.find((item) => item.sessionID === session.id)
            expect(entry?.resumeAt).toEqual(expect.any(Number))
            return entry?.resumeAt ?? 0
          },
          { timeout: 60_000, interval: 250 },
        )

        const { pill } = installOn(host, { session: { id: session.id } })
        expect(pill.id).toBe("waiting")
        expect(pill.show({ session: { id: "elsewhere" } })).toBeUndefined()
        // Three calendar days out: the weekday names the day it resumes.
        const shown = await vi.waitFor(() => {
          const view = pill.show({ session: { id: session.id } })
          expect(view?.label).toMatch(/^Waiting · resumes (Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d\d:\d\d$/)
          return view
        })
        expect(shown).toMatchObject({ tone: "warning", icon: "status" })
        expect(shown?.title).toContain("continues this session automatically")

        // The GUI's clock, not the server's, decides how the label reads.
        const viewedAt = async (now: number, label: RegExp): Promise<void> => {
          vi.useFakeTimers({ toFake: ["Date"], now })
          try {
            await project["settings.set"]({ inviteDismissed: true }, at)
            await vi.waitFor(
              () => {
                expect(pill.show({ session: { id: session.id } })?.label).toMatch(label)
              },
              { timeout: 15_000, interval: 100 },
            )
          } finally {
            vi.useRealTimers()
          }
        }
        await viewedAt(parked - 60_000, /^Waiting · resumes \d\d:\d\d$/)
        await viewedAt(
          parked - 10 * 24 * 3600_000,
          /^Waiting · resumes [A-Z][a-z]{2} \d{1,2} \d\d:\d\d$/,
        )
        await viewedAt(parked + 60_000, /^Waiting · resuming$/)

        // Pinned to a model whose key was rejected, nothing says when the session can go on.
        const other = await host.client.session.create()
        // Both instances route prompts, so both hear the tier request.
        await rpc(host).tierRequest.set(other.id, "quick")
        await project["tier-request.set"]({ sessionID: other.id, tier: "quick" }, at)
        await host.client.session.prompt({ sessionID: other.id, text: "use the quick model" })
        await vi.waitFor(
          async () => {
            expect((await reads()).tiers.quick[0]?.health).toBe("unavailable")
          },
          { timeout: 60_000, interval: 250 },
        )
        await settle({ pin: THREE })
        await vi.waitFor(
          () => {
            expect(pill.show({ session: { id: session.id } })?.label).toBe("Waiting")
          },
          { timeout: 15_000, interval: 100 },
        )

        // Only active sessions wait: switching the session off ends the wait in the pill too.
        await located(host).setMode(session.id, "off")
        await vi.waitFor(
          () => {
            expect(pill.show({ session: { id: session.id } })).toBeUndefined()
          },
          { timeout: 15_000, interval: 100 },
        )
      } finally {
        await host.close()
      }
    })
  })

  describe("failures", () => {
    it("toasts and ends when the settings cannot be read", async () => {
      const client = interceptRpc(main.client, (method, call) =>
        method === "settings.get" ? Promise.reject(new Error("boom")) : call(),
      )
      const { gui, command } = installOn(main, { client })
      gui.open(command)
      await gui.finished()
      expect(gui.toasts).toHaveLength(1)
      expect(gui.toasts[0]).toMatchObject({ variant: "error" })
      expect(gui.toasts[0]?.title).toContain("boom")
    })
  })

  describe("manual actions", () => {
    it("resumes and cancels parked work, resets a limited model and runs the doctor", async () => {
      const host = await startHost({ models: MODELS })
      const project = host.client.rpc(adaptiveRpc)
      const at = { location: { directory: host.project } }
      const settle = async (patch: Record<string, unknown>): Promise<void> => {
        await rpc(host).settings.set(patch)
        await project["settings.set"](patch, at)
      }
      try {
        await settle({
          mode: "active",
          tiers: { quick: [], standard: [FAKE], advanced: [] },
          inviteDismissed: true,
        })
        // Days of quota: the session parks and the model is marked limited,
        // which gives Health something to reset.
        host.provider.setModelScripts({
          "fake-model": {
            behaviors: [
              {
                status: 429,
                headers: { "retry-after": String(3 * 24 * 3600) },
                body: JSON.stringify({
                  error: { message: "You exceeded your current quota", type: "insufficient_quota" },
                }),
              },
            ],
          },
        })
        const session = await host.client.session.create()
        await host.client.session.prompt({ sessionID: session.id, text: "finish this" })
        await vi.waitFor(
          async () => {
            const snap = await project["status.get"](undefined, at)
            expect(snap.waiting.some((item) => item.sessionID === session.id)).toBe(true)
          },
          { timeout: 60_000, interval: 250 },
        )

        const { gui, command } = installOn(host, { session: { id: session.id } })
        gui.open(command)
        let menu = await gui.next("Adaptive (active)")
        // Resume now finds the tier still unavailable and says the wait goes on.
        menu.choose("Parked work")
        const parked = await gui.next("Parked work")
        parked.choose("This session")
        const run = await gui.next("This session's parked work")
        run.choose("Resume now")
        const waiting = await gui.next("Parked work")
        expect(waiting.description).toContain("No model in this tier is available yet")
        waiting.ok()
        menu = await gui.next("Adaptive (active)")
        // Cancel drops the wait entirely.
        menu.choose("Parked work")
        const parkedAgain = await gui.next("Parked work")
        parkedAgain.choose("This session")
        const drop = await gui.next("This session's parked work")
        drop.choose("Cancel")
        menu = await gui.next("Adaptive (active)")
        // Health lists the limited model; confirming resets it.
        menu.choose("Health")
        const limited = await gui.next("Health · select a model to reset")
        limited.choose("fake/fake-model")
        const confirmReset = await gui.next("Reset model health?")
        confirmReset.answer(true)
        menu = await gui.next("Adaptive (active)")
        // The doctor reports from the same instance's status.
        menu.choose("Doctor")
        const report = await gui.next("Adaptive doctor")
        expect(report.kind).toBe("custom")
        expect(report.text()).toContain("No parked work")
        report.escape()
        ;(await gui.next("Adaptive (active)")).dismiss()
        await gui.finished()
        expect(gui.toasts).toEqual([
          { title: "Parked work cancelled", variant: "success" },
          { title: "Health reset", variant: "success" },
        ])
      } finally {
        await host.close()
      }
    })
  })
})
