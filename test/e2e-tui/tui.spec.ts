/**
 * T-26: real-PTY TUI journeys on a real OpenCode TUI with the packed plugin
 * loaded against a sidecar fake provider (ADP-043).
 *
 * Reachable journeys: boot/first-run state, keyboard-only palette
 * navigation, the full /adaptive dialog flow (first-run invitation, status
 * alert, observe→control mode switch with persistence, receipts empty state,
 * Escape cancellation at every level), a full session turn through the fake
 * provider, and dimension runs.
 *
 * Host facts (empirical, OpenCode 2.2.5):
 * - Plugin TUI bundles mount only from the HOME-based global config
 *   (~/.config/opencode/opencode.json). A project-local `plugins` entry
 *   registers the palette command but its RPC calls fail with
 * `rpc.unavailable`; the $XDG_CONFIG_HOME config file is not consulted for
 *   plugin discovery at all (probed: 16 palette attempts never matched).
 * - The plugin's keymap layer registers asynchronously some seconds after
 *   the boot prompt appears, so the palette match is retried.
 * - The `/adaptive` slash form does not match in the slash menu ("No
 *   matching commands"); the command palette (ctrl+p) is the keyboard path.
 * - Select dialogs highlight the first option on open; Arrow keys move the
 *   highlight and Enter activates it, Escape cancels. The host persists the
 *   "Settings saved" toast until manually dismissed, so toast text is only
 *   asserted on its first appearance — later saves are verified by
 *   re-reading the status alert instead.
 */
// covers: ["ADP-043"]
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

interface Launched {
  app: TerminalApp
  sidecar: Sidecar
  servicePort: number
}

/** Launch one fresh TUI against its own fake-provider sidecar. */
async function launchTui(tw: TermwrightFixture, terminal: TerminalFixture): Promise<Launched> {
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
    command: [sidecarNode, sidecarEntry, "--port", String(port)],
    ready: { output: "FAKE_PROVIDER_READY", stream: "stdout" },
  })
  expect(sidecar.pid).toBeGreaterThan(0)

  const home = mkdtempSync(join(tmpdir(), "adaptive-tui-home-"))
  mkdirSync(join(home, "config", "opencode"), { recursive: true })
  mkdirSync(join(home, ".config", "opencode"), { recursive: true })
  mkdirSync(join(home, "data"), { recursive: true })
  mkdirSync(join(home, "cache"), { recursive: true })
  const project = mkdtempSync(join(tmpdir(), "adaptive-tui-proj-"))
  const opencodeJson = JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    model: "fake/fake-model",
    provider: {
      fake: {
        npm: "@ai-sdk/openai-compatible",
        name: "Fake",
        options: { baseURL: `http://127.0.0.1:${String(port)}/v1` },
        models: {
          "fake-model": { name: "Fake Model" },
          "fake-model-2": { name: "Fake Model 2" },
        },
      },
    },
  })
  // The plugin must be configured in the GLOBAL config for the TUI to mount
  // its bundle: a project-local plugins entry registers the palette command
  // but every rpc(definition) call fails with rpc.unavailable, and the
  // $XDG_CONFIG_HOME config file is not consulted for plugin discovery at
  // all (both probed empirically on 2.2.5). The TUI resolves the global
  // config from the HOME-based path, so the entry is written there; the
  // XDG copy is kept because `opencode service set port` writes its
  // service.json under XDG_CONFIG_HOME.
  const globalJson = JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    plugins: [REPO_ROOT],
  })
  writeFileSync(join(home, ".config", "opencode", "opencode.json"), globalJson)
  writeFileSync(join(home, "config", "opencode", "opencode.json"), globalJson)

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
  return { app, sidecar, servicePort }
}

/** Boot the TUI and wait for the home screen. */
async function bootTui(launched: Launched): Promise<void> {
  await launched.app.waitForText("Ask anything", { timeout: 150_000 })
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
  await app.waitForText(/OpenCode Adaptive|Health of every configured resource/, {
    timeout: 30_000,
  })
}

/** Confirm the first-run invitation if it is up; lands on the main menu. */
async function confirmInvite(app: TerminalApp): Promise<void> {
  await app.waitForQuiet({ quietMs: 200 })
  if (app.screen().text().includes("OpenCode Adaptive")) {
    await app.press("Enter")
    await app.waitForText("Health of every configured resource", { timeout: 30_000 })
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
  await launched.sidecar.close()
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
  await launched.sidecar.close()
})

test("a session turn runs through the fake provider and answers", async ({
  termwright: tw,
  terminal,
}) => {
  const launched = await launchTui(tw, terminal)
  await bootTui(launched)
  await step("session turn", async () => {
    await launched.app.type("say done")
    await launched.app.press("Enter")
    // The sidecar's success script answers "done".
    await launched.app.waitForText("done", { timeout: 120_000 })
  })
  await launched.app.close()
  await launched.sidecar.close()
})

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
      // Enter activates the Confirm button (the dialog default).
      await app.press("Enter")
      // The save toasts once and the main menu opens.
      await app.waitForText("Settings saved", { timeout: 30_000 })
      await app.waitForText("Health of every configured resource", { timeout: 30_000 })
    })
    await step("escape closes the menu", async () => {
      await app.press("Escape")
      await app.waitForText("Ask anything", { timeout: 15_000 })
    })
    await app.close()
    await launched.sidecar.close()
  },
)

test(
  "the status flow shows the observe snapshot and escape backs out of every level",
  { timeout: 120_000 },
  async ({ termwright: tw, terminal }) => {
    const launched = await launchTui(tw, terminal)
    const app = launched.app
    await bootTui(launched)
    await step("status alert on a fresh install", async () => {
      await openAdaptiveMenu(app)
      // The main menu highlights its first option (status) on open.
      await app.press("Enter")
      await app.waitForText("Adaptive status", { timeout: 30_000 })
      await app.waitForText("mode: observe", { timeout: 15_000 })
      await app.waitForText("pin: none", { timeout: 15_000 })
    })
    await step("escape dismisses the alert back into the menu", async () => {
      await app.press("Escape")
      await app.waitForText("Health of every configured resource", { timeout: 15_000 })
    })
    await step("escape from the mode menu returns to the menu, not home", async () => {
      await pressAll(app, ["ArrowDown"])
      await app.press("Enter")
      await app.waitForText("Adaptive does nothing", { timeout: 30_000 })
      // Cancelling the mode menu reopens the main menu (cancel path).
      await app.press("Escape")
      await app.waitForText("Health of every configured resource", { timeout: 15_000 })
    })
    await step("escape closes the menu", async () => {
      await app.press("Escape")
      await app.waitForText("Ask anything", { timeout: 15_000 })
    })
    await app.close()
    await launched.sidecar.close()
  },
)

test(
  "switching to control persists and the status alert reflects it",
  { timeout: 120_000 },
  async ({ termwright: tw, terminal }) => {
    const launched = await launchTui(tw, terminal)
    const app = launched.app
    await bootTui(launched)
    await step("switch the operating mode to control", async () => {
      await openAdaptiveMenu(app)
      await pressAll(app, ["ArrowDown"])
      await app.press("Enter")
      await app.waitForText("Adaptive does nothing", { timeout: 30_000 })
      // The mode menu highlights "off" on open; control is two rows down.
      // The save toast is already on screen from the invitation dismissal
      // (the host never auto-dismisses it), so the switch is verified by
      // re-reading the status below instead of the toast.
      await pressAll(app, ["ArrowDown", "ArrowDown"])
      await app.press("Enter")
      // Applying the patch reopens the main menu.
      await app.waitForText("Health of every configured resource", { timeout: 30_000 })
    })
    await step("the switch survives closing and reopening the flow", async () => {
      await app.press("Escape")
      await app.waitForText("Ask anything", { timeout: 15_000 })
      // Re-open: the invitation must not reappear (dismissal persisted) and
      // the menu comes back directly.
      await runAdaptiveCommand(app)
      await app.waitForText("Health of every configured resource", { timeout: 30_000 })
      await app.press("Enter")
      await app.waitForText("Adaptive status", { timeout: 30_000 })
      await app.waitForText("mode: control", { timeout: 15_000 })
    })
    await step("escape back home", async () => {
      await app.press("Escape")
      await app.waitForText("Health of every configured resource", { timeout: 15_000 })
      await app.press("Escape")
      await app.waitForText("Ask anything", { timeout: 15_000 })
    })
    await app.close()
    await launched.sidecar.close()
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
      // Receipts is the fifth menu option; the highlight starts on status.
      await pressAll(app, ["ArrowDown", "ArrowDown", "ArrowDown", "ArrowDown"])
      await app.press("Enter")
      await app.waitForText("No decisions recorded yet.", { timeout: 30_000 })
    })
    await step("escape dismisses the alert and closes the menu", async () => {
      await app.press("Escape")
      await app.waitForText("Health of every configured resource", { timeout: 15_000 })
      await app.press("Escape")
      await app.waitForText("Ask anything", { timeout: 15_000 })
    })
    await app.close()
    await launched.sidecar.close()
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
  await launched.sidecar.close()
})

test.override({ termwrightOptions: { columns: 200, rows: 50 } })
test("the command palette navigates at wide width", async ({ termwright: tw, terminal }) => {
  const launched = await launchTui(tw, terminal)
  await bootTui(launched)
  await openPalette(launched.app)
  await launched.app.press("escape")
  await launched.app.waitForText("Ask anything", { timeout: 15_000 })
  await launched.app.close()
  await launched.sidecar.close()
})
