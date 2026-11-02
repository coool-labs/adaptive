/**
 * T-26: real-PTY TUI journeys on a real OpenCode TUI with the packed plugin
 * loaded against a sidecar fake provider (ADP-043).
 *
 * Reachable journeys: boot/first-run state, keyboard-only palette
 * navigation, the full /adaptive dialog flow (first-run invitation with its
 * follow-up select, the single-page status view with its empty state,
 * observe→active mode switch with persistence, receipts
 * empty state and detail, Escape cancellation at every level), the tier
 * editor (search-and-add, move-to-top reorder, remove with confirm/cancel,
 * persistence within the session), the pin flow with its menu and status-page
 * rendering, a full session turn through the fake provider, the per-session
 * mode override (Follow global select, override markers, effective-mode menu
 * title, global mode untouched), the reconnect
 * after the background service daemon dies, and dimension runs.
 *
 * Host facts (empirical, OpenCode 2.2.5):
 * - Plugin TUI bundles mount only from the HOME-based global config
 *   (~/.config/opencode/opencode.json). A project-local `plugins` entry
 *   registers the palette command but its RPC calls fail with
 * `rpc.unavailable`; the $XDG_CONFIG_HOME config file is not consulted for
 *   plugin discovery at all (probed: 16 palette attempts never matched).
 * - The plugin's keymap layer registers asynchronously some seconds after
 *   the boot prompt appears, so the palette match is retried.
 * - The `/` slash menu lists `/adaptive` (the first entry); Enter on the
 *   open menu activates it — the slash path is covered by its own journey.
 *   (Typing the full "/adaptive" string races the slash filter; the reliable
 *   keyboard path is slash-then-Enter.)
 * - Select dialogs highlight the first option on open; Arrow keys move the
 *   highlight and Enter activates it, Escape cancels. The host persists the
 *   "Settings saved" toast until manually dismissed, and the flow shows it
 *   only on the FIRST successful save of a dialog session — the toast is
 *   asserted only right after the invitation dismissal; every later save is
 *   verified by re-reading the resulting state (menu descriptions, tier
 *   counts, editor rows) instead.
 */
// covers: ["ADP-043", "ADP-054"]
import { expect, step, test } from "@termwright/test"
import type { TermwrightFixtures } from "@termwright/test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { REPO_ROOT } from "../runtime-e2e/helpers.js"

// The fake-provider sidecar needs a Termwright-certified Node (22/24). Locally
// the default runtime may be newer (v26), so fall back to the nvm install; on
// CI the job pins Node 24, so the current runtime is already certified.
const sidecarNode = [22, 24].includes(Number.parseInt(process.version.slice(1), 10))
  ? process.execPath
  : `${process.env["HOME"] ?? ""}/.nvm/versions/node/v24.15.0/bin/node`
// CI runners install opencode elsewhere (npm i -g @opencode/cli); the
// homebrew path is only the local default.
const OPENCODE = process.env["OPENCODE_BIN"] ?? "/opt/homebrew/bin/opencode"
const PASSWORD = "adaptive-e2e"

const stripTokens = (env: NodeJS.ProcessEnv): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (/API_TOKEN|API_KEY|_TOKEN$/.test(key)) continue
    if (value !== undefined) out[key] = value
  }
  return out
}

type TermwrightFixture = TermwrightFixtures["termwright"]
type TerminalFixture = TermwrightFixtures["terminal"]
type TerminalApp = Awaited<ReturnType<TerminalFixture["launch"]>>
type Sidecar = Awaited<ReturnType<TermwrightFixture["sidecars"]["launch"]>>

/**
 * The /adaptive main-menu select titles itself after the operating mode, so
 * the title is both the menu anchor and the mode evidence.
 */
const MENU_TITLE = /Adaptive \((?:observe|active|off)\)/

interface Launched {
  app: TerminalApp
  sidecar: Sidecar
  servicePort: number
  /** The sandbox home (receipt seeding for the pagination journey). */
  home: string
  project: string
}

/** Launch one fresh TUI against its own fake-provider sidecar. */
async function launchTui(
  tw: TermwrightFixture,
  terminal: TerminalFixture,
  options: { failAfterTitle?: boolean; paths?: { home: string; project: string } } = {},
): Promise<Launched> {
  // Bundle the sidecar entry to plain JS: the termwright host node has no TS
  // loader, and vite-node is not shipped by this dependency tree.
  const sidecarEntry = join(tw.tmpdir, "fake-provider-sidecar.mjs")
  const bundle = spawnSync(
    join(REPO_ROOT, "node_modules", ".bin", "esbuild"),
    [
      join(REPO_ROOT, "test", "fixtures", "fake-provider", "main.ts"),
      "--bundle",
      "--platform=node",
      "--format=esm",
      `--outfile=${sidecarEntry}`,
    ],
    { cwd: REPO_ROOT },
  )
  expect(bundle.status).toBe(0)

  // Unique per-test even port; the service port is the odd neighbor, so
  // concurrent tests never collide and 49374 (the user's own TUI) is
  // never touched.
  const port = 40_000 + 2 * Math.floor(Math.random() * 9_000)
  const sidecar = await tw.sidecars.launch({
    command: [
      sidecarNode,
      sidecarEntry,
      "--port",
      String(port),
      ...(options.failAfterTitle === true ? ["--fail-after-title"] : []),
    ],
    ready: { output: "FAKE_PROVIDER_READY", stream: "stdout" },
  })
  expect(sidecar.pid).toBeGreaterThan(0)

  const home = options.paths?.home ?? mkdtempSync(join(tmpdir(), "adaptive-tui-home-"))
  mkdirSync(join(home, "config", "opencode"), { recursive: true })
  mkdirSync(join(home, ".config", "opencode"), { recursive: true })
  mkdirSync(join(home, "data"), { recursive: true })
  mkdirSync(join(home, "cache"), { recursive: true })
  const project = options.paths?.project ?? mkdtempSync(join(tmpdir(), "adaptive-tui-proj-"))
  // The provider definition must be present in BOTH configs: the plugin's
  // server-side model inventory is scoped to the location the plugin loads
  // from — the global config in this sandbox — so a provider that exists
  // only in the project config leaves the tier resources "not-in-inventory"
  // and every admission parks (probed empirically: the health journey
  // recorded `park: no-compatible-resource — not-in-inventory` before the
  // provider was mirrored into the global config).
  const fakeProvider = {
    npm: "@ai-sdk/openai-compatible",
    name: "Fake",
    options: { baseURL: `http://127.0.0.1:${String(port)}/v1` },
    models: {
      "fake-model": { name: "Fake Model" },
      "fake-model-2": { name: "Fake Model 2" },
    },
  }
  const opencodeJson = JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    model: "fake/fake-model",
    provider: { fake: fakeProvider },
  })
  // The plugin must be configured in the GLOBAL config for the TUI to mount
  // its bundle: a project-local plugins entry registers the palette command
  // but every rpc(definition) call fails with rpc.unavailable, and the
  // $XDG_CONFIG_HOME config file is not consulted for plugin discovery at
  // all (both probed empirically on 2.2.5). The TUI resolves the global
  // config from the HOME-based path, so the entry is written there; the
  // XDG copy is kept because `opencode service set port` writes its
  // service.json under XDG_CONFIG_HOME.
  // Both global config files carry the provider (the server-side model
  // inventory is scoped to the plugin's load location), but the `plugins`
  // entry lives ONLY in the XDG copy: when both global configs list the
  // plugin, the server loads it once per config source — two supervisors in
  // one process, where the event pump records health in the first instance's
  // registry while status.get is served by the second's empty one (probed
  // with pid-tagged instrumentation: both instances in pid <service>, health
  // observed by inst=1, every status read served by inst=2 with health=[]).
  const globalJsonXdg = JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    provider: { fake: fakeProvider },
    plugins: [REPO_ROOT],
  })
  const globalJsonHome = JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    provider: { fake: fakeProvider },
  })
  writeFileSync(join(home, ".config", "opencode", "opencode.json"), globalJsonHome)
  writeFileSync(join(home, "config", "opencode", "opencode.json"), globalJsonXdg)

  const env = stripTokens(process.env)
  env["HOME"] = home
  env["XDG_CONFIG_HOME"] = join(home, "config")
  env["XDG_DATA_HOME"] = join(home, "data")
  env["XDG_CACHE_HOME"] = join(home, "cache")
  env["OPENCODE_SERVER_PASSWORD"] = PASSWORD
  env["TERM"] = "xterm-256color"

  // The TUI's background service binds a managed port that defaults to a
  // FIXED value (49374) — the user's own opencode session may own it, and
  // concurrent tests would collide. Give this test's TUI its own port via
  // the documented config command (writes $XDG_CONFIG_HOME/opencode/
  // service.json).
  const servicePort = port + 1
  const setPort = spawnSync(OPENCODE, ["service", "set", "port", String(servicePort)], {
    cwd: project,
    env,
  })
  expect(setPort.status).toBe(0)

  const app = await terminal.launch({
    command: [OPENCODE],
    files: { "opencode.json": opencodeJson },
    env,
    cwd: project,
  })
  return { app, sidecar, servicePort, home, project }
}

/**
 * Plant receipts directly in the sandbox's plugin storage between two boots:
 * the store loads them at plugin setup, so the receipts browser can be
 * exercised with more than a page of data without replaying dozens of turns
 * (the "Getting started" popup blocks a second turn in one boot anyway).
 */
function seedReceipts(home: string, count: number): void {
  const hex = (text: string): string => {
    let out = ""
    for (const c of text) out += c.charCodeAt(0).toString(16).padStart(4, "0")
    return out
  }
  const now = Date.now()
  const receipts = Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    at: now - (count - index) * 60_000,
    sessionID: `seed-${String(index)}`,
    decision: { kind: "defer", reason: "routing-defer" },
  }))
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

/** Boot the TUI and wait for the home screen. */
async function bootTui(launched: Launched): Promise<void> {
  await launched.app.waitForText("Ask anything", { timeout: 150_000 })
}

/**
 * Submit a prompt and wait until the turn has actually completed. The
 * latency status line ("Build · <model> · <N>ms") only appears after a
 * finished turn, so it is a real completion marker — unlike waiting for the
 * reply text, which also matches the typed prompt itself. The host can drop
 * the Enter keystroke right after per-key typing (the same drop the palette
 * shows right after opening), so Enter is retried until the latency marker
 * proves the turn ran; with the fake provider answering in well under a
 * second, a completed turn always wins the race against the next retry.
 * The one-time "Getting started" onboarding popup that appears over the
 * home screen afterwards does not block dialog navigation, so it is left up.
 */
async function submitTurn(app: TerminalApp, text: string): Promise<void> {
  await app.type(text)
  for (let attempt = 0; attempt < 5; attempt++) {
    await app.press("Enter")
    try {
      await app.waitForText(/· \d+ms/, { timeout: 4_000 })
      break
    } catch (error) {
      if (attempt === 4) throw error
      await app.waitForQuiet({ quietMs: 500 })
    }
  }
  await app.waitForQuiet({ quietMs: 1_000 })
}

/**
 * Close the TUI and its sidecar, then kill the TUI's background service
 * daemon: it binds the configured managed service port and outlives the TUI
 * process, so a suite that spawns many TUIs would leak one daemon per test.
 * The user's own TUI daemon is never touched — only this test's port.
 */
async function closeLaunched(launched: Launched): Promise<void> {
  await launched.sidecar.close()
  killServiceDaemon(launched)
}

/** Kill the TUI's background service daemon by its configured port. */
function killServiceDaemon(launched: Launched): void {
  const listener = spawnSync(
    "lsof",
    ["-t", `-iTCP:${String(launched.servicePort)}`, "-sTCP:LISTEN"],
    { encoding: "utf8" },
  )
  const pid = listener.stdout.trim().split("\n")[0] ?? ""
  if (pid !== "") spawnSync("kill", [pid])
}

/** Open the command palette and wait for the unfiltered command list. */
async function openPalette(app: Launched["app"]): Promise<void> {
  await app.press("ctrl+p")
  await app.waitForText("Commands", { timeout: 15_000 })
  await app.waitForText("Switch model", { timeout: 10_000 })
}

/**
 * Run the Adaptive command from the palette and wait for its first dialog.
 * The plugin's keymap layer registers asynchronously after the boot prompt,
 * so open/type/retry until the command matches; typing one key at a time
 * keeps the palette's search from dropping keystrokes right after it opens.
 * The first invocation shows the first-run invitation, later ones go
 * straight to the main menu (the dismissal persists server-side).
 */
async function runAdaptiveCommand(app: TerminalApp): Promise<void> {
  await app.waitForQuiet({ quietMs: 2_000 })
  for (let attempt = 1; ; attempt++) {
    await openPalette(app)
    for (const key of ["a", "d", "a", "p", "t", "i", "v", "e"]) {
      await app.press(key)
      await app.waitForQuiet({ quietMs: 100 })
    }
    await app.waitForQuiet({ quietMs: 500 })
    const text = app.screen().text()
    if (!text.includes("Adaptive") || text.includes("No results found")) {
      await app.press("Escape")
      await app.waitForText("Ask anything", { timeout: 10_000 })
      if (attempt > 15) throw new Error(`adaptive never matched (${String(attempt)} attempts)`)
      continue
    }
    break
  }
  await app.press("Enter")
  await app.waitForText(/OpenCode Adaptive|Adaptive \((?:observe|active|off)\)/, {
    timeout: 30_000,
  })
}

/** Open /adaptive through the editor slash menu (slash, then Enter). */
async function runAdaptiveSlash(app: TerminalApp): Promise<void> {
  await app.waitForQuiet({ quietMs: 2_000 })
  // The keymap layer registers seconds after boot; a palette open/close
  // cycle both waits for it and leaves a clean editor for the slash input.
  await app.press("ctrl+p")
  await app.waitForText("Commands", { timeout: 30_000 })
  await app.press("Escape")
  await app.waitForQuiet({ quietMs: 1_000 })
  await app.type("/")
  await app.waitForQuiet({ quietMs: 500 })
  await app.press("Enter")
  await app.waitForText(/OpenCode Adaptive|Adaptive \((?:observe|active|off)\)/, {
    timeout: 30_000,
  })
}

/**
 * Confirm the first-run invitation if it is up; lands on the main menu.
 * The invitation is two dialogs: a confirm (its message names Observe mode),
 * then a select titled "OpenCode Adaptive" whose highlighted first option
 * "Open the menu now" proceeds into the menu ("Later" or Escape ends the
 * run). Confirming also saves the dismissal — the first save of the session,
 * so the "Settings saved" toast appears here and nowhere else in the session.
 */
async function confirmInvite(app: TerminalApp): Promise<void> {
  await app.waitForQuiet({ quietMs: 200 })
  if (app.screen().text().includes("Adaptive starts in Observe mode")) {
    await app.press("Enter")
    await app.waitForText("Open the menu now", { timeout: 30_000 })
    await app.press("Enter")
    await app.waitForText(MENU_TITLE, { timeout: 30_000 })
  }
}

/** Open the /adaptive main menu, confirming the invitation on first run. */
async function openAdaptiveMenu(app: TerminalApp): Promise<void> {
  await runAdaptiveCommand(app)
  await confirmInvite(app)
}

/** Press keys one by one, settling between them. */
async function pressAll(app: TerminalApp, keys: string[]): Promise<void> {
  for (const key of keys) {
    await app.press(key)
    await app.waitForQuiet({ quietMs: 100 })
  }
}

/**
 * Close the main menu and land on the base screen. After any turn has run,
 * the host shows the one-time "Getting started" onboarding popup there —
 * its ✕ is mouse-only, Escape does not dismiss it — and the composer
 * placeholder is no longer shown, so either popup text or the placeholder
 * proves the menu layer is closed.
 */
async function leaveMenuToBase(app: TerminalApp): Promise<void> {
  await app.press("Escape")
  try {
    await app.waitForText("Getting started", { timeout: 5_000 })
  } catch {
    await app.waitForText("Ask anything", { timeout: 15_000 })
  }
}

/**
 * Escape open dialog layers until the /adaptive main menu is on screen.
 * Keystrokes can be dropped right after a dialog transition, so a fixed
 * number of Escapes is not enough — the menu text is the condition.
 */
async function backToAdaptiveMenu(app: TerminalApp): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await app.waitForText(MENU_TITLE, { timeout: 5_000 })
      return
    } catch (error) {
      if (attempt === 3) throw error
      await app.press("Escape")
      await app.waitForQuiet({ quietMs: 300 })
    }
  }
}

/**
 * Escape open dialog layers until the base screen is back. Escape at the
 * base screen is a no-op (it does not even clear the editor), so pressing a
 * full dialog-stack depth of Escapes is safe and needs no knowledge of which
 * layers are open — text-based early exits would be unreliable, because
 * dialog overlays do not hide the base texts from the screen reader.
 */
async function escapeToBase(app: TerminalApp): Promise<void> {
  for (let escape = 0; escape < 5; escape++) {
    await app.press("Escape")
    await app.waitForQuiet({ quietMs: 200 })
  }
  try {
    await app.waitForText("Ask anything", { timeout: 5_000 })
  } catch {
    await app.waitForText("Getting started", { timeout: 5_000 })
  }
}

/**
 * From the main menu, activate the highlighted Status entry and wait for the
 * one-page view (every model with its state, grouped by tier). The
 * activating Enter can be dropped while the menu re-renders: retry only
 * while the menu is still open — if an Enter landed somewhere deeper, reset
 * instead of pressing blindly.
 */
async function openStatusPage(app: TerminalApp, match: RegExp): Promise<void> {
  for (let enter = 0; enter < 3; enter++) {
    await app.press("Enter")
    try {
      await app.waitForText(match, { timeout: 12_000 })
      return
    } catch {
      let menuStillOpen = true
      try {
        await app.waitForText(MENU_TITLE, { timeout: 2_000 })
      } catch {
        menuStillOpen = false
      }
      if (!menuStillOpen) throw new Error("drifted out of the adaptive menu")
    }
  }
  throw new Error("status page never opened")
}

test("the tui boots to the first-run home with the configured model", async ({
  termwright: tw,
  terminal,
}) => {
  const launched = await launchTui(tw, terminal)
  await step("tui boots", async () => {
    await bootTui(launched)
  })
  // First-run home: the editor prompt is empty and the configured fake
  // provider model is the active agent model.
  await launched.app.waitForText("Fake Model", { timeout: 15_000 })
  await launched.app.close()
  await closeLaunched(launched)
})

test("the command palette is keyboard-operable and escapable", async ({
  termwright: tw,
  terminal,
}) => {
  const launched = await launchTui(tw, terminal)
  await bootTui(launched)
  await step("keyboard-only palette", async () => {
    await openPalette(launched.app)
    // Escape returns to the unchanged home screen (cancel path).
    await launched.app.press("escape")
    await launched.app.waitForText("Ask anything", { timeout: 15_000 })
  })
  await launched.app.close()
  await closeLaunched(launched)
})

test(
  "backspace does not navigate host select dialogs (host-limitation canary)",
  { timeout: 180_000 },
  async ({ termwright: tw, terminal }) => {
    const launched = await launchTui(tw, terminal)
    const app = launched.app
    await bootTui(launched)
    await step("backspace leaves the main menu open", async () => {
      await openAdaptiveMenu(app)
      // Host behavior, probed on 2.2.5: Backspace inside a select dialog does
      // nothing (the dialog's search input owns the key, and a bound action
      // would be dispatched BEFORE the input — probed with a synthetic Back
      // action, then removed by decision because it swallowed the keystroke
      // even when the query had text, making typed filters undeletable).
      // Escape remains the only close key. If a future host lets Backspace
      // reach plugin handling, this canary flips and Backspace-as-back can be
      // reintroduced properly.
      await app.press("backspace")
      await app.waitForText(MENU_TITLE, { timeout: 3_000 })
      await app.press("Escape")
      await app.waitForText(/Ask anything|Getting started/, { timeout: 15_000 })
    })
    await app.close()
    await closeLaunched(launched)
  },
)

test(
  "a session turn runs through the fake provider and answers",
  { timeout: 120_000 },
  async ({ termwright: tw, terminal }) => {
    const launched = await launchTui(tw, terminal)
    await bootTui(launched)
    await step("session turn", async () => {
      // The sidecar's success script answers "done".
      await submitTurn(launched.app, "say done")
    })
    await launched.app.close()
    await closeLaunched(launched)
  },
)

test(
  "the adaptive command opens the first-run invitation and confirming lands in the main menu",
  { timeout: 120_000 },
  async ({ termwright: tw, terminal }) => {
    const launched = await launchTui(tw, terminal)
    const app = launched.app
    await bootTui(launched)
    await step("invitation", async () => {
      await runAdaptiveCommand(app)
      // The first-run invitation names the plugin and the Observe default.
      await app.waitForText("Adaptive starts in Observe mode", { timeout: 15_000 })
      // Enter activates the Confirm button (the dialog default); a follow-up
      // select then offers "Open the menu now" (highlighted first) or "Later".
      await app.press("Enter")
      await app.waitForText("Open the menu now", { timeout: 30_000 })
      await app.waitForText("Later", { timeout: 15_000 })
      // Enter picks the highlighted "Open the menu now": the dismissal is
      // saved — the first save of the session, so the toast shows — and the
      // main menu opens, titled after the observe mode it starts in.
      await app.press("Enter")
      await app.waitForText("Settings saved", { timeout: 30_000 })
      await app.waitForText("Adaptive (observe)", { timeout: 30_000 })
    })
    await step("escape closes the menu", async () => {
      await app.press("Escape")
      await app.waitForText("Ask anything", { timeout: 15_000 })
    })
    await app.close()
    await closeLaunched(launched)
  },
)

test(
  "the /adaptive slash form opens the same flows through the editor slash menu",
  { timeout: 120_000 },
  async ({ termwright: tw, terminal }) => {
    const launched = await launchTui(tw, terminal)
    const app = launched.app
    await bootTui(launched)
    await step("slash menu activation", async () => {
      // The bare `/` slash menu lists /adaptive among its entries; Enter on
      // the open menu activates the highlighted entry.
      await runAdaptiveSlash(app)
      await app.waitForText("Adaptive starts in Observe mode", { timeout: 15_000 })
    })
    await step("confirm lands in the main menu", async () => {
      await confirmInvite(app)
      await app.waitForText("Adaptive (observe)", { timeout: 30_000 })
    })
    await step("escape closes the menu", async () => {
      await app.press("Escape")
      await app.waitForText("Ask anything", { timeout: 15_000 })
    })
    await app.close()
    await closeLaunched(launched)
  },
)

test(
  "the status page shows its empty state on a fresh install and escape backs out of every level",
  { timeout: 120_000 },
  async ({ termwright: tw, terminal }) => {
    const launched = await launchTui(tw, terminal)
    const app = launched.app
    await bootTui(launched)
    await step("status empty state on a fresh install", async () => {
      await openAdaptiveMenu(app)
      // The main menu highlights its first option (Status) on open, and its
      // description degrades to the nothing-configured line.
      await app.waitForText("no models configured yet", { timeout: 15_000 })
      await app.press("Enter")
      await app.waitForText("No models configured yet — open Models to add some.", {
        timeout: 30_000,
      })
    })
    await step("escape dismisses the alert back into the menu", async () => {
      await app.press("Escape")
      await app.waitForText("Adaptive (observe)", { timeout: 15_000 })
    })
    await step("escape from the mode menu returns to the menu, not home", async () => {
      // Mode is the third menu option (Status, Models, Mode, Pin, Receipts).
      await pressAll(app, ["ArrowDown", "ArrowDown"])
      await app.press("Enter")
      // The unified target select asks which mode to steer even on home.
      await app.waitForText("Global mode…", { timeout: 30_000 })
      // Cancelling the mode menu reopens the main menu (cancel path).
      await app.press("Escape")
      await app.waitForText("Adaptive (observe)", { timeout: 15_000 })
    })
    await step("the pin menu degrades to an alert with nothing configured", async () => {
      // A fresh open starts the highlight on Status, so Pin is three rows
      // down; the empty pin menu is an alert, not a select.
      await leaveMenuToBase(app)
      await runAdaptiveCommand(app)
      await app.waitForText("Adaptive (observe)", { timeout: 30_000 })
      await pressAll(app, ["ArrowDown", "ArrowDown", "ArrowDown"])
      await app.press("Enter")
      await app.waitForText("(no configured resources to pin)", { timeout: 30_000 })
      // Escaping the alert reopens the main menu (cancel path).
      await app.press("Escape")
      await app.waitForText("Adaptive (observe)", { timeout: 15_000 })
    })
    await step("escape closes the menu", async () => {
      await app.press("Escape")
      await app.waitForText("Ask anything", { timeout: 15_000 })
    })
    await app.close()
    await closeLaunched(launched)
  },
)

test(
  "switching to active persists and the menu reflects it",
  { timeout: 120_000 },
  async ({ termwright: tw, terminal }) => {
    const launched = await launchTui(tw, terminal)
    const app = launched.app
    await bootTui(launched)
    await step("switch the operating mode to active", async () => {
      await openAdaptiveMenu(app)
      // Mode is the third menu option.
      await pressAll(app, ["ArrowDown", "ArrowDown"])
      await app.press("Enter")
      await app.waitForText("Global mode…", { timeout: 30_000 })
      // The unified target select lists "Global mode…" first on home too;
      // Enter takes that target, then the global mode list highlights "off".
      await app.press("Enter")
      await app.waitForText("Adaptive does nothing", { timeout: 30_000 })
      // The mode menu highlights "off" on open; active is two rows down.
      // The invitation dismissal was this session's first (and only) save,
      // so the switch itself stays silent — it is verified by the reopened
      // menu's mode line below instead of a toast.
      await pressAll(app, ["ArrowDown", "ArrowDown"])
      await app.press("Enter")
      // Applying the patch reopens the main menu, now titled and described
      // after the active mode.
      await app.waitForText("currently active", { timeout: 30_000 })
    })
    await step("the switch survives closing and reopening the flow", async () => {
      await app.press("Escape")
      await app.waitForText("Ask anything", { timeout: 15_000 })
      // Re-open: the invitation must not reappear (dismissal persisted) and
      // the menu comes back directly, titled after the persisted mode.
      await runAdaptiveCommand(app)
      await app.waitForText("Adaptive (active)", { timeout: 30_000 })
    })
    await step("escape back home", async () => {
      await app.press("Escape")
      await app.waitForText("Ask anything", { timeout: 15_000 })
    })
    await app.close()
    await closeLaunched(launched)
  },
)

test(
  "the receipts flow reports the empty state before any decision",
  { timeout: 120_000 },
  async ({ termwright: tw, terminal }) => {
    const launched = await launchTui(tw, terminal)
    const app = launched.app
    await bootTui(launched)
    await step("empty receipts alert", async () => {
      await openAdaptiveMenu(app)
      // Receipts is the fifth menu option; the highlight starts on Status.
      await pressAll(app, ["ArrowDown", "ArrowDown", "ArrowDown", "ArrowDown"])
      await app.press("Enter")
      await app.waitForText("No decisions recorded yet.", { timeout: 30_000 })
    })
    await step("escape dismisses the alert and closes the menu", async () => {
      await app.press("Escape")
      await app.waitForText("Adaptive (observe)", { timeout: 15_000 })
      await app.press("Escape")
      await app.waitForText("Ask anything", { timeout: 15_000 })
    })
    await app.close()
    await closeLaunched(launched)
  },
)

test(
  "the receipts flow shows the recorded decision after a session turn",
  { timeout: 180_000 },
  async ({ termwright: tw, terminal }) => {
    const launched = await launchTui(tw, terminal)
    const app = launched.app
    await bootTui(launched)
    await step("session turn records a routing decision", async () => {
      await submitTurn(app, "say done")
    })
    await step("the receipts dialog lists the real decision line", async () => {
      await openAdaptiveMenu(app)
      await pressAll(app, ["ArrowDown", "ArrowDown", "ArrowDown", "ArrowDown"])
      await app.press("Enter")
      // Observe mode with no tiers configured: the admission deferred with
      // reason routing-defer / tier-not-configured — the dialog must show
      // that recorded decision, not the empty state.
      await app.waitForText(/defer: routing-defer/, { timeout: 30_000 })
    })
    await step("the receipt detail explains what happened in plain language", async () => {
      // The first receipt is highlighted; Enter opens its detail alert.
      await app.press("Enter")
      await app.waitForText(/Receipt #\d+/, { timeout: 30_000 })
      // The timestamp line is relative with the ISO stamp in parentheses,
      // and the detail ends with the plain-language explanation (observe
      // mode records the decision as observe-only, so the explanation names
      // the observation rather than the would-be routing). The full sentence
      // wraps at 80 columns, so the assertion anchors on its short head.
      await app.waitForText(/when: just now \(\d{4}-\d{2}-\d{2}T/, { timeout: 15_000 })
      await app.waitForText("What happened: Adaptive is observing", { timeout: 15_000 })
      await app.press("Escape")
      await app.waitForText(/defer: routing-defer/, { timeout: 15_000 })
    })
    await step("escape dismisses the alert and closes the menu", async () => {
      await app.press("Escape")
      await app.waitForText("Adaptive (observe)", { timeout: 15_000 })
      await leaveMenuToBase(app)
    })
    await app.close()
    await closeLaunched(launched)
  },
)

test(
  "the receipts browser pages forward and back through the whole list",
  { timeout: 300_000 },
  async ({ termwright: tw, terminal }) => {
    const paths = {
      home: mkdtempSync(join(tmpdir(), "adaptive-tui-home-")),
      project: mkdtempSync(join(tmpdir(), "adaptive-tui-proj-")),
    }
    // First boot: creates the plugin storage the seeding then fills.
    const first = await launchTui(tw, terminal, { paths })
    await bootTui(first)
    await first.app.close()
    await closeLaunched(first)
    seedReceipts(paths.home, 25)

    // Second boot on the same sandbox: the store loads the seeded receipts.
    const launched = await launchTui(tw, terminal, { paths })
    const app = launched.app
    await bootTui(launched)
    await step("page one lists the newest receipts and offers the next page", async () => {
      await openAdaptiveMenu(app)
      // Receipts is the last (fifth) menu option.
      await pressAll(app, ["ArrowDown", "ArrowDown", "ArrowDown", "ArrowDown"])
      await app.press("Enter")
      await app.waitForText("Receipts (25, newest first)", { timeout: 30_000 })
      // Newest first: the top row is the highest seeded id. "Next page" is
      // a footer action (not a list item), triggered by its ctrl+f binding.
      await app.waitForText("#25 ", { timeout: 15_000 })
      await app.waitForText("Next page", { timeout: 15_000 })
      await app.press("ctrl+f")
    })
    await step("page two offers the way back to page one", async () => {
      await app.waitForText("Previous page", { timeout: 15_000 })
      // The remaining 5 receipts are listed on this page.
      await app.waitForText("#1 ", { timeout: 15_000 })
      await app.press("ctrl+b")
    })
    await step("page one is shown again after going back", async () => {
      await app.waitForText("Receipts (25, newest first)", { timeout: 15_000 })
      await app.waitForText("#25 ", { timeout: 15_000 })
      await app.waitForText("Next page", { timeout: 15_000 })
    })
    await escapeToBase(app)
    await app.close()
    await closeLaunched(launched)
  },
)

test(
  "switching to off disables routing and the menu reflects it",
  { timeout: 120_000 },
  async ({ termwright: tw, terminal }) => {
    const launched = await launchTui(tw, terminal)
    const app = launched.app
    await bootTui(launched)
    await step("switch the operating mode to off", async () => {
      await openAdaptiveMenu(app)
      // Mode is the third menu option.
      await pressAll(app, ["ArrowDown", "ArrowDown"])
      await app.press("Enter")
      await app.waitForText("Global mode…", { timeout: 30_000 })
      // The unified target select lists "Global mode…" first; Enter takes
      // that target, then the global mode list highlights "off".
      await app.press("Enter")
      await app.waitForText("Adaptive does nothing", { timeout: 30_000 })
      // "off" is highlighted first in the mode menu; applying the patch
      // reopens the main menu.
      await app.press("Enter")
      await app.waitForText("currently off", { timeout: 30_000 })
    })
    await step("escape closes the menu", async () => {
      await leaveMenuToBase(app)
    })
    await app.close()
    await closeLaunched(launched)
  },
)

test(
  "the status page shows a windowed resource and its recovery deadline after a failed turn",
  { timeout: 300_000 },
  async ({ termwright: tw, terminal }) => {
    const launched = await launchTui(tw, terminal, { failAfterTitle: true })
    const app = launched.app
    await bootTui(launched)
    await step("switch to active and seed the standard tier", async () => {
      await openAdaptiveMenu(app)
      // Mode is the third menu option; the unified target select asks which
      // mode to steer even on home, and "Global mode…" is highlighted first.
      await pressAll(app, ["ArrowDown", "ArrowDown"])
      await app.press("Enter")
      await app.waitForText("Global mode…", { timeout: 30_000 })
      await app.press("Enter")
      await app.waitForText("Adaptive does nothing", { timeout: 30_000 })
      await pressAll(app, ["ArrowDown", "ArrowDown"])
      await app.press("Enter")
      await app.waitForText("currently active", { timeout: 30_000 })
      // The patch-reopened menu can keep the highlight on the mode row, so
      // close it and re-open fresh: a fresh menu always starts the highlight
      // on Health, which the tier navigation below relies on.
      await app.press("Escape")
      await app.waitForText("Ask anything", { timeout: 15_000 })
      await openAdaptiveMenu(app)
      await openTierMenu(app, 0)
      // First turns route to the DEFAULT standard tier (the agent hint is
      // unobserved on a fresh session), so the failed turn only marks the
      // tier resource when the resource lives in standard — quick would
      // defer with "tier-not-configured" and never engage the health story.
      await pressAll(app, ["ArrowDown"])
      await app.press("Enter")
      await app.waitForText("Tier: standard", { timeout: 30_000 })
      await addHighlightedModel(app, ["f", "a", "k", "e"], 1, "standard")
      // Back out to the base screen: tier menu -> main menu -> base. The
      // helpers self-correct against dropped Escape keystrokes.
      await backToAdaptiveMenu(app)
      await leaveMenuToBase(app)
    })
    await step("the status page shows every resource on one screen", async () => {
      await app.type("say done")
      await app.waitForQuiet({ quietMs: 2_000 })
      // The provider answers a quota-shaped 429, so the turn fails instead
      // of completing and there is no completion marker — the health event
      // from the failed call is the signal. Enter retries cover the host's
      // dropped-keystroke behavior: a retry only re-submits when the line
      // has not shown yet, and a duplicate failing turn changes nothing.
      for (let attempt = 0; attempt < 5; attempt++) {
        await app.press("Enter")
        try {
          // openAdaptiveMenu can throw when the host drops the palette
          // keystroke right after the failed turn re-renders the footer;
          // retrying it inside the loop covers that drop.
          await openAdaptiveMenu(app)
          // Status is the highlighted first menu option; it opens with the
          // WHOLE inventory as one column-aligned table — a header row, then
          // one row per model (tier order, priority order within tiers).
          // The dialog is widened to xlarge precisely so the row fits on
          // one line: the full row (health, windowed state, clock deadline)
          // must render without wrapping.
          await openStatusPage(app, /rate_limited\s+windowed until \d{2}:\d{2}/)
          // The dialog body is padded and carries the esc hint in the title
          // row's right corner.
          await app.waitForText("esc", { timeout: 10_000 })
          return
        } catch (error) {
          if (attempt === 4) throw error
          // Reset to a known state before retrying: the number of open
          // dialog layers varies with what actually rendered, so escape
          // until the base screen is back instead of guessing.
          await escapeToBase(app)
          await app.waitForQuiet({ quietMs: 500 })
        }
      }
    })
    await escapeToBase(app)
    await app.close()
    await closeLaunched(launched)
  },
)

test(
  "the tui reconnects after its background service restarts",
  { timeout: 300_000 },
  async ({ termwright: tw, terminal }) => {
    const launched = await launchTui(tw, terminal)
    const app = launched.app
    await bootTui(launched)
    await step("killing the daemon loses the service connection", async () => {
      killServiceDaemon(launched)
      // The dead transport surfaces as a transient "ECONNREFUSED" banner
      // with a "Restarting service…" toast instead of exiting — observed on
      // live probes, but the banner is not guaranteed to still be up when
      // the poller looks, so its absence is tolerated; the asserted behavior
      // is the recovery below.
      try {
        await app.waitForText("ECONNREFUSED", { timeout: 8_000 })
      } catch {
        // The banner already flashed by; recovery is what matters.
      }
    })
    await step("a turn runs again after the service restarts", async () => {
      // The TUI restarts its background service on its own; the completed
      // turn (the latency status marker) proves the fresh daemon serves
      // model calls end to end. The settle gives the restart time to finish
      // before the first submit, and submitTurn's Enter retries absorb a
      // submit that lands while the service is still coming back.
      await app.waitForQuiet({ quietMs: 10_000 })
      await submitTurn(app, "say done")
    })
    await leaveMenuToBase(app)
    await app.close()
    await closeLaunched(launched)
  },
)

// Tier-editor and pin journeys (ADP-033). Facts verified live (OpenCode
// 2.2.5): the tier list menu titles its options `quick (N)` / `standard (N)` /
// `advanced (N)`, described by the resources they hold (`p/a · p/b`) or
// "(empty — add models to enable routing)"; the editor select is titled
// `Tier: <tier>` and lists "Add model…" first, one row per resource
// (`provider/model`, empty health tag while healthy) — no "Back" row: Escape
// steps back out (undefined pick re-shows the tier list). The model
// picker shows EVERY catalog entry on an empty query — not just the
// configured fake provider: the opencode/* builtin free models come first,
// the fake models (`fake/fake-model`, then `fake/fake-model-2`) are the last
// two entries, and EVERY picker model has host-reported variants
// (`@low`/`@medium`/…): picking one opens the `Variant: <model>` select,
// where "(model default)" is highlighted first and Enter keeps the resource
// label variant-free. Filtering with "fake" therefore narrows the picker to
// exactly the two fake models. Option rows render title and description on
// one line, and screen rows are padded to the full width, so label-boundary
// regexes anchor on `\s` after the label: `fake/fake-model\s` matches the
// bare label's row (or the `Resource: fake/fake-model` title) but not the
// `fake/fake-model-2` row, whose label continues with `-2`. The resource
// menu offers "Move to top", "Move up", "Move down" and "Remove" (the
// remove goes through the "Remove resource" confirm). The "Settings saved"
// toast appears only on the FIRST save of a dialog session (the invitation
// dismissal already used it), so later saves are never asserted via the
// toast — they are verified by re-reading the resulting state (tier counts,
// editor rows, menu descriptions) instead.
// Each test boots its own sandbox, so leftover tier entries never leak
// between tests; the cleanup journeys themselves are covered by the remove
// and clear-pin steps below.

/** Activate the main-menu option at `index` (status 0, models 1, mode 2, pin 3, receipts 4). */
async function chooseMainMenuItem(app: TerminalApp, index: number): Promise<void> {
  await pressAll(
    app,
    Array.from({ length: index }, () => "ArrowDown"),
  )
  await app.press("Enter")
}

/** From the main menu, open the models flow and land on the tier list menu. */
async function openTierMenu(app: TerminalApp, quickCount: number): Promise<void> {
  await chooseMainMenuItem(app, 1)
  await app.waitForText(`quick (${String(quickCount)})`, { timeout: 30_000 })
}

/** From the tier list menu, enter the quick tier editor (quick is highlighted). */
async function openQuickEditor(app: TerminalApp): Promise<void> {
  await app.press("Enter")
  await app.waitForText("Tier: quick", { timeout: 30_000 })
}

/**
 * From a tier editor, add a model through the picker: "Add model…" is the
 * highlighted first option, `keys` are typed into the picker search one key
 * at a time (with any ArrowDown moves appended), and Enter activates the
 * highlighted entry. Every picker model — the fake ones included — then opens
 * the `Variant: <model>` select (variants are host-reported), where Enter
 * accepts the highlighted "(model default)" and keeps the resource label
 * variant-free. The flow lands back on the tier menu, verified by the tier's
 * count growing to `newCount` (`tier` defaults to quick, whose editor is
 * entered without any ArrowDown moves).
 */
async function addHighlightedModel(
  app: TerminalApp,
  keys: string[],
  newCount: number,
  tier: "quick" | "standard" | "advanced" = "quick",
): Promise<void> {
  await app.press("Enter")
  await app.waitForText("Search provider / model / name", { timeout: 30_000 })
  await pressAll(app, keys)
  await app.waitForQuiet({ quietMs: 300 })
  await app.press("Enter")
  await app.waitForText(/Variant: fake\/fake-model/, { timeout: 30_000 })
  await app.press("Enter")
  await app.waitForText(`${tier} (${String(newCount)})`, { timeout: 30_000 })
}

test(
  "the tier editor adds a model through search and saves it",
  { timeout: 180_000 },
  async ({ termwright: tw, terminal }) => {
    const launched = await launchTui(tw, terminal)
    const app = launched.app
    await bootTui(launched)
    await step("open the quick tier editor", async () => {
      await openAdaptiveMenu(app)
      await openTierMenu(app, 0)
      await openQuickEditor(app)
      await app.waitForText("Add model…", { timeout: 15_000 })
    })
    await step("the model picker lists the fake catalog", async () => {
      await app.press("Enter")
      await app.waitForText("Search provider / model / name", { timeout: 30_000 })
      await app.waitForText("fake/fake-model-2", { timeout: 15_000 })
      await app.waitForText("Fake Model 2", { timeout: 15_000 })
    })
    await step("filter the picker to fake-model-2 and save", async () => {
      // "fake" narrows the picker to the two fake models in catalog order
      // (fake-model first), so one ArrowDown lands on fake-model-2.
      await pressAll(app, ["f", "a", "k", "e", "ArrowDown"])
      await app.waitForQuiet({ quietMs: 300 })
      await app.press("Enter")
      await app.waitForText(/Variant: fake\/fake-model/, { timeout: 30_000 })
      await app.press("Enter")
      await app.waitForText("quick (1)", { timeout: 30_000 })
    })
    await step("reopening the editor lists the saved resource", async () => {
      await openQuickEditor(app)
      await app.waitForText(/fake\/fake-model-2\s/, { timeout: 15_000 })
    })
    await step("escape back out to home", async () => {
      await app.press("Escape")
      await app.waitForText("quick (1)", { timeout: 15_000 })
      await app.press("Escape")
      await app.waitForText(MENU_TITLE, { timeout: 15_000 })
      await app.press("Escape")
      await app.waitForText("Ask anything", { timeout: 15_000 })
    })
    await app.close()
    await closeLaunched(launched)
  },
)

test(
  "the tier editor reorders and removes resources with confirmation",
  { timeout: 240_000 },
  async ({ termwright: tw, terminal }) => {
    const launched = await launchTui(tw, terminal)
    const app = launched.app
    await bootTui(launched)
    await step("seed quick with fake-model and fake-model-2", async () => {
      await openAdaptiveMenu(app)
      await openTierMenu(app, 0)
      await openQuickEditor(app)
      // The "fake" filter narrows the picker to the two fake models in
      // catalog order (fake-model first), so the highlighted entry is
      // fake-model; one ArrowDown then lands on fake-model-2.
      await addHighlightedModel(app, ["f", "a", "k", "e"], 1)
      await openQuickEditor(app)
      await addHighlightedModel(app, ["f", "a", "k", "e", "ArrowDown"], 2)
    })
    await step("move the second resource to the top", async () => {
      await openQuickEditor(app)
      await pressAll(app, ["ArrowDown", "ArrowDown"])
      await app.press("Enter")
      await app.waitForText(/Resource: fake\/fake-model-2\s/, { timeout: 30_000 })
      // The resource menu offers "Move to top" (make this the primary
      // resource), "Move up", "Move down" and "Remove"; "Move to top" is
      // highlighted first and moves fake-model-2 ahead of fake-model.
      await app.waitForText("Make this the primary resource", { timeout: 15_000 })
      await app.press("Enter")
      await app.waitForText("quick (2)", { timeout: 30_000 })
    })
    await step("the reordered editor puts fake-model-2 first", async () => {
      await openQuickEditor(app)
      await pressAll(app, ["ArrowDown"])
      await app.press("Enter")
      await app.waitForText(/Resource: fake\/fake-model-2\s/, { timeout: 30_000 })
    })
    await step("escaping the remove confirm keeps the resource", async () => {
      await app.press("Escape")
      await app.waitForText("quick (2)", { timeout: 15_000 })
      await openQuickEditor(app)
      await pressAll(app, ["ArrowDown"])
      await app.press("Enter")
      await app.waitForText(/Resource: fake\/fake-model-2\s/, { timeout: 30_000 })
      // Remove is the fourth resource-menu option (after Move to top, Move
      // up, Move down).
      await pressAll(app, ["ArrowDown", "ArrowDown", "ArrowDown"])
      await app.press("Enter")
      await app.waitForText("Remove fake/fake-model-2 from quick?", { timeout: 30_000 })
      await app.press("Escape")
      await app.waitForText("quick (2)", { timeout: 30_000 })
      await openQuickEditor(app)
      await app.waitForText(/fake\/fake-model\s/, { timeout: 15_000 })
      await app.waitForText(/fake\/fake-model-2\s/, { timeout: 15_000 })
    })
    await step("confirming the remove saves and drops the resource", async () => {
      await pressAll(app, ["ArrowDown"])
      await app.press("Enter")
      await app.waitForText(/Resource: fake\/fake-model-2\s/, { timeout: 30_000 })
      // Remove is the fourth resource-menu option (after Move to top, Move
      // up, Move down).
      await pressAll(app, ["ArrowDown", "ArrowDown", "ArrowDown"])
      await app.press("Enter")
      await app.waitForText("Remove fake/fake-model-2 from quick?", { timeout: 30_000 })
      await app.press("Enter")
      await app.waitForText("quick (1)", { timeout: 30_000 })
      await openQuickEditor(app)
      await pressAll(app, ["ArrowDown"])
      await app.press("Enter")
      // Only fake-model remains: entering the first resource row must name
      // it, which also proves the removed label is gone from the list.
      await app.waitForText(/Resource: fake\/fake-model\s/, { timeout: 30_000 })
    })
    await step("escape back out to home", async () => {
      await app.press("Escape")
      await app.waitForText("quick (1)", { timeout: 15_000 })
      await app.press("Escape")
      await app.waitForText(MENU_TITLE, { timeout: 15_000 })
      await app.press("Escape")
      await app.waitForText("Ask anything", { timeout: 15_000 })
    })
    await app.close()
    await closeLaunched(launched)
  },
)

test(
  "pinning a resource shows in the menu and health detail and can be cleared",
  { timeout: 240_000 },
  async ({ termwright: tw, terminal }) => {
    const launched = await launchTui(tw, terminal)
    const app = launched.app
    await bootTui(launched)
    await step("seed quick with fake-model", async () => {
      await openAdaptiveMenu(app)
      await openTierMenu(app, 0)
      await openQuickEditor(app)
      await addHighlightedModel(app, ["f", "a", "k", "e"], 1)
      // The controller loads settings once per /adaptive run and the tier
      // editor never returns its updates to the main-menu loop, so a
      // just-added resource is invisible to the pin menu until the flow is
      // re-entered (the re-open reads the server truth afresh).
      await app.press("Escape")
      await app.waitForText(MENU_TITLE, { timeout: 15_000 })
      await app.press("Escape")
      await app.waitForText("Ask anything", { timeout: 15_000 })
      await runAdaptiveCommand(app)
      await app.waitForText(MENU_TITLE, { timeout: 30_000 })
    })
    await step("pin fake/fake-model", async () => {
      await chooseMainMenuItem(app, 3)
      await app.waitForText("No pin", { timeout: 30_000 })
      await app.waitForText("fake/fake-model (quick)", { timeout: 15_000 })
      await pressAll(app, ["ArrowDown"])
      await app.press("Enter")
      // First save of this dialog session: the toast shows once, and the
      // reopened menu describes the pin in its Pin row.
      await app.waitForText("Settings saved", { timeout: 30_000 })
      await app.waitForText("pinned to fake/fake-model", { timeout: 30_000 })
      // The patch-reopened menu can keep the highlight on the pin row, so
      // close it and re-open fresh before entering Status (whose navigation
      // below relies on the fresh menu's first-option highlight).
      await app.press("Escape")
      await app.waitForText("Ask anything", { timeout: 15_000 })
      await runAdaptiveCommand(app)
      await app.waitForText("Adaptive (observe)", { timeout: 30_000 })
    })
    await step("the status table marks the pinned resource", async () => {
      // Status is the highlighted first menu option; the pinned (healthy)
      // resource's STATE column carries the pin marker on the table view.
      await openStatusPage(app, /healthy\s+\(pinned\)/)
      await app.press("Escape")
      await app.waitForText(MENU_TITLE, { timeout: 15_000 })
    })
    await step("clearing the pin restores the force-one-resource description", async () => {
      await chooseMainMenuItem(app, 3)
      await app.waitForText("No pin", { timeout: 30_000 })
      await app.press("Enter")
      // Second save of the session: silent — the reopened menu's Pin
      // description is the evidence.
      await app.waitForText("force one resource", { timeout: 30_000 })
    })
    await step("escape back home", async () => {
      await app.press("Escape")
      await app.waitForText("Ask anything", { timeout: 15_000 })
    })
    await app.close()
    await closeLaunched(launched)
  },
)

test(
  "a per-session mode override steers only that session's menu and leaves the global mode",
  { timeout: 180_000 },
  async ({ termwright: tw, terminal }) => {
    const launched = await launchTui(tw, terminal)
    const app = launched.app
    await bootTui(launched)
    // A completed turn creates the session the command then runs inside —
    // the override flows target THIS session. The one-time "Getting started"
    // popup appears over the base screen afterwards; the palette still works
    // over it, so it is left up.
    await submitTurn(app, "say done")
    await step("the session's mode menu offers global and session targets", async () => {
      await openAdaptiveMenu(app)
      await app.waitForText("Adaptive (observe)", { timeout: 30_000 })
      await chooseMainMenuItem(app, 2)
      // The first select asks which mode to steer: the global default or
      // this session's override.
      await app.waitForText("Global mode…", { timeout: 30_000 })
      await app.waitForText("This session…", { timeout: 15_000 })
      // Enter the session target: highlight starts on "Global mode…".
      await pressAll(app, ["ArrowDown"])
      await app.press("Enter")
      // The session override select lists Follow global first, then the
      // modes; the inherited global mode carries the current marker.
      await app.waitForText("Follow global (observe)", { timeout: 30_000 })
      await app.waitForText("observe (current)", { timeout: 15_000 })
    })
    await step("picking active overrides the session", async () => {
      // Highlight starts on Follow global; active is three rows down.
      await pressAll(app, ["ArrowDown", "ArrowDown", "ArrowDown"])
      await app.press("Enter")
      // The override save is silent (the invitation dismissal was this
      // dialog session's first save); the retitled menu is the evidence.
      await app.waitForText("Adaptive (active)", { timeout: 30_000 })
    })
    await step("the override survives closing and reopening the flow", async () => {
      await app.press("Escape")
      await leaveMenuToBase(app)
      await runAdaptiveCommand(app)
      await app.waitForText("Adaptive (active)", { timeout: 30_000 })
    })
    await step("the global mode stayed observe", async () => {
      await chooseMainMenuItem(app, 2)
      await app.waitForText("Global mode…", { timeout: 30_000 })
      await pressAll(app, ["ArrowDown"])
      await app.press("Enter")
      // The Follow global row still names the untouched global mode; the
      // override row is now marked instead of the inherited mode.
      await app.waitForText("Follow global (observe)", { timeout: 30_000 })
      await app.waitForText("active (override)", { timeout: 15_000 })
    })
    await step("escape back home", async () => {
      // Escaping the mode menu reopens the main menu (cancel path), so a
      // full dialog-stack depth of Escapes lands on the base screen.
      await escapeToBase(app)
    })
    await app.close()
    await closeLaunched(launched)
  },
)

// Dimension coverage (GOAL: >=80x24 plus narrow and wide variants): run the
// boot journey at the classic 80x24 and the palette journey wide.
test.override({ termwrightOptions: { columns: 80, rows: 24 } })
test("the tui boots at 80x24", async ({ termwright: tw, terminal }) => {
  const launched = await launchTui(tw, terminal)
  await bootTui(launched)
  expect(launched.app.screen().text()).toContain("Ask anything")
  await launched.app.close()
  await closeLaunched(launched)
})

test.override({ termwrightOptions: { columns: 200, rows: 50 } })
test("the command palette navigates at wide width", async ({ termwright: tw, terminal }) => {
  const launched = await launchTui(tw, terminal)
  await bootTui(launched)
  await openPalette(launched.app)
  await launched.app.press("escape")
  await launched.app.waitForText("Ask anything", { timeout: 15_000 })
  await launched.app.close()
  await closeLaunched(launched)
})
