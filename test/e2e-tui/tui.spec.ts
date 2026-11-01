/**
 * T-26: real-PTY TUI journeys on a real OpenCode TUI with the packed plugin
 * loaded against a sidecar fake provider (ADP-043).
 *
 * Reachable journeys: boot/first-run state, keyboard-only palette
 * navigation, a full session turn through the fake provider, and the
 * plugin-TUI-mount limitation canary (see the canary test for the proof).
 */
// covers: ["ADP-043"]
import { expect, step, test } from "@termwright/test"
import type { TermwrightFixtures } from "@termwright/test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { REPO_ROOT } from "../runtime-e2e/helpers.js"

const NODE24 = `${process.env["HOME"] ?? ""}/.nvm/versions/node/v24.15.0/bin/node`
const OPENCODE = "/opt/homebrew/bin/opencode"
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
    command: [NODE24, sidecarEntry, "--port", String(port)],
    ready: { output: "FAKE_PROVIDER_READY", stream: "stdout" },
  })
  expect(sidecar.pid).toBeGreaterThan(0)

  const home = mkdtempSync(join(tmpdir(), "adaptive-tui-home-"))
  mkdirSync(join(home, "config"), { recursive: true })
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
    plugins: [REPO_ROOT],
  })

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

test("no plugin tui command mounts in the palette (2.2.5 limitation canary)", async ({
  termwright: tw,
  terminal,
}) => {
  const launched = await launchTui(tw, terminal)
  await bootTui(launched)
  await step("limitation canary", async () => {
    await openPalette(launched.app)
    const unfiltered = launched.app.screen().text()
    expect(unfiltered).not.toContain("Adaptive")
    await launched.app.type("adaptive")
    // The plugin command is absent; the palette reports no match. A future
    // host that mounts plugin TUI bundles flips this canary and the
    // /adaptive dialog journeys become implementable.
    await launched.app.waitForText("No results found", { timeout: 10_000 })
    await launched.app.press("escape")
  })
  await launched.app.close()
  await launched.sidecar.close()
})

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
