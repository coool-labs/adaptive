import { spawn, type ChildProcess } from "node:child_process"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { createServer, type Server } from "node:http"
import { OpenCode } from "@opencode/client"
import { createFakeProvider, type FakeProvider } from "../fixtures/fake-provider/server.js"
import { FAKE_SCENARIOS, type FakeProviderScript } from "../fixtures/fake-provider/scenarios.js"
import { ADAPTIVE_RPC_ID } from "../../src/rpc/definition.js"

// import.meta.dirname/url are unreliable under vite-node (not file URLs), so
// resolve the repo root by walking up to this package's manifest.
export const REPO_ROOT = ((): string => {
  let dir = process.cwd()
  for (;;) {
    if (
      existsSync(join(dir, "package.json")) &&
      readFileSync(join(dir, "package.json"), "utf8").includes(`"name": "@coool/opencode-adaptive"`)
    ) {
      return dir
    }
    const parent = dirname(dir)
    if (parent === dir) throw new Error("could not locate @coool/opencode-adaptive package root")
    dir = parent
  }
})()
export const HOST_PASSWORD = "adaptive-e2e"
const BOOT_TIMEOUT_MS = 90_000

const STARTED_HOSTS: StartedHost[] = []

/**
 * Closes every host this process started (and removes its temp dirs). The
 * web E2E teardown cannot carry the live handle across the setup/teardown
 * module boundary, so the registry is the shared channel.
 */
export async function closeAllHosts(): Promise<void> {
  for (const host of [...STARTED_HOSTS].reverse()) {
    await host.close()
  }
  STARTED_HOSTS.length = 0
}

// The plugin-context client binds definitions via client.rpc(definition); the
// raw @opencode/client exposes only the generic call — unwrap it here.
export interface HostRpc {
  settings: {
    get(): Promise<unknown>
    set(patch: unknown): Promise<unknown>
  }
  status: {
    get(): Promise<unknown>
  }
  receipts: {
    list(): Promise<unknown>
  }
}

export interface StartedHost {
  client: ReturnType<typeof OpenCode.make>
  baseUrl: string
  provider: FakeProvider
  stderrLines(): string[]
  home: string
  project: string
  run(input: { text: string; script?: FakeProviderScript; sessionID?: string }): Promise<HostRun>
  close(): Promise<void>
}

export interface HostRun {
  sessionID: string
}

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe: Server = createServer()
    probe.once("error", reject)
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address()
      const port = typeof address === "object" && address !== null ? address.port : 0
      probe.close(() => {
        if (port > 0) resolve(port)
        else reject(new Error("no free port"))
      })
    })
  })

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const TITLE_SUCCESS: FakeProviderScript = {
  behaviors: [
    {
      body: JSON.stringify({
        id: "cmpl-title",
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "e2e session" },
            finish_reason: "stop",
          },
        ],
      }),
    },
  ],
}

const authHeaders = (): Record<string, string> => ({
  authorization: `Basic ${Buffer.from(`opencode:${HOST_PASSWORD}`).toString("base64")}`,
})

export async function startHost(
  options: {
    script?: FakeProviderScript
    models?: Record<string, { name: string }>
    /** Reuse an existing home/project pair (restart scenarios). The caller
     * owns cleanup for reused paths; close() then only stops the host. */
    paths?: { home: string; project: string }
  } = {},
): Promise<StartedHost> {
  const owned = options.paths === undefined
  const home = options.paths?.home ?? mkdtempSync(join(tmpdir(), "adaptive-e2e-home-"))
  const project = options.paths?.project ?? mkdtempSync(join(tmpdir(), "adaptive-e2e-proj-"))
  if (owned) for (const dir of ["config", "data", "cache"]) mkdirSync(join(home, dir))

  // Fresh sessions get a title model call before any scripted scenario runs,
  // so every script we hand the provider is front-loaded with a benign success.
  const provider = await createFakeProvider(
    options.script === undefined
      ? { behaviors: [TITLE_SUCCESS.behaviors[0]] }
      : { behaviors: [TITLE_SUCCESS.behaviors[0], ...options.script.behaviors] },
  )

  const port = await freePort()
  writeFileSync(
    join(project, "opencode.json"),
    JSON.stringify(
      {
        model: "fake/fake-model",
        provider: {
          fake: {
            npm: "@ai-sdk/openai-compatible",
            name: "Fake",
            options: { baseURL: `${provider.url}/v1`, apiKey: "fake" },
            models: options.models ?? { "fake-model": { name: "Fake Model" } },
          },
        },
        plugins: [REPO_ROOT],
      },
      null,
      2,
    ),
  )

  // Ambient provider credentials (e.g. CLOUDFLARE_API_TOKEN) make the host's
  // model catalog eager-initialize that provider and fail the whole model
  // resolution with provider.no-route whenever an episode runs on OpenCode's
  // own model (defer path). E2E hosts must be hermetic.
  const childEnv: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!/API_TOKEN|API_KEY|_TOKEN$/.test(key)) childEnv[key] = value
  }
  const child: ChildProcess = spawn(
    "/opt/homebrew/bin/opencode",
    ["serve", "--port", String(port), "--hostname", "127.0.0.1"],
    {
      cwd: project,
      env: {
        ...childEnv,
        HOME: home,
        XDG_CONFIG_HOME: join(home, "config"),
        XDG_DATA_HOME: join(home, "data"),
        XDG_CACHE_HOME: join(home, "cache"),
        OPENCODE_SERVER_PASSWORD: HOST_PASSWORD,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  )
  let stderr = ""
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk)
  })
  const stderrLines = (): string[] => stderr.split("\n").filter((line) => line.length > 0)

  const baseUrl = `http://127.0.0.1:${String(port)}`
  const client = OpenCode.make({ baseUrl, headers: authHeaders() })

  const deadline = Date.now() + BOOT_TIMEOUT_MS
  let ready = false
  let bootError = ""
  while (Date.now() < deadline && !ready) {
    await wait(500)
    try {
      await client.plugin.list()
      // plugin.list() only proves the HTTP surface is up — the plugin's setup
      // (and with it the RPC registration) completes asynchronously, so poll
      // the RPC surface as the real readiness gate.
      const probe = await fetch(`${baseUrl}/api/rpc/${ADAPTIVE_RPC_ID}/settings.get`, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: "{}",
      })
      ready = probe.ok
    } catch (error) {
      bootError = String(error)
    }
  }
  if (!ready) {
    child.kill("SIGKILL")
    await provider.close()
    if (owned) {
      rmSync(home, { recursive: true, force: true })
      rmSync(project, { recursive: true, force: true })
    }
    throw new Error(
      `opencode serve did not become ready within ${String(BOOT_TIMEOUT_MS)}ms; stderr: ${stderr.slice(0, 2000) || bootError}`,
    )
  }

  const run = async (input: {
    text: string
    script?: FakeProviderScript
    sessionID?: string
  }): Promise<HostRun> => {
    // A fresh session triggers an unsupervised title model call before the
    // main prompt, so every per-run script must front-load one benign success
    // behavior or the title would consume the first scripted behavior.
    if (input.script !== undefined) {
      provider.setScript({
        behaviors: [TITLE_SUCCESS.behaviors[0], ...input.script.behaviors],
      })
    }
    const sessionID = input.sessionID ?? (await client.session.create()).id
    await client.session.prompt({ sessionID, text: input.text })
    await client.session.wait({ sessionID })
    return { sessionID }
  }

  const close = async (): Promise<void> => {
    // The host ignores a bare SIGTERM (observed: orphaned `opencode serve`
    // processes survived it), so give it a short grace period, then SIGKILL
    // and await exit — a leaked server would keep ports and state files held.
    child.kill("SIGTERM")
    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => {
        resolve()
      })
    })
    const grace = wait(500).then(() => {
      child.kill("SIGKILL")
    })
    await Promise.race([exited, grace])
    await exited
    await provider.close()
    if (owned) {
      rmSync(home, { recursive: true, force: true })
      rmSync(project, { recursive: true, force: true })
    }
    STARTED_HOSTS.splice(STARTED_HOSTS.indexOf(started), 1)
  }
  const started: StartedHost = { client, baseUrl, provider, stderrLines, home, project, run, close }
  STARTED_HOSTS.push(started)
  return started
}

// The raw POST transport, exposed for wire-level tests (invalid input gates).
export const rpcRaw = (host: StartedHost, method: string, body: unknown): Promise<Response> =>
  fetch(`${host.baseUrl}/api/rpc/${ADAPTIVE_RPC_ID}/${method}`, {
    method: "POST",
    headers: { ...authHeaders(), "content-type": "application/json" },
    body: JSON.stringify(body),
  })

export const rpc = (host: StartedHost): HostRpc => {
  // Raw wire contract (verified T-23/T-24): POST /api/rpc/<rpcID>/<method> with a
  // JSON object whose `input` field carries the call input; `{}` IS the void input.
  const call = async (method: string, input?: unknown): Promise<unknown> => {
    const response = await rpcRaw(host, method, input === undefined ? {} : { input })
    if (!response.ok)
      throw new Error(`rpc ${method} failed: ${String(response.status)} ${await response.text()}`)
    const payload: unknown = await response.json()
    if (typeof payload !== "object" || payload === null || !("output" in payload)) {
      throw new Error(`rpc ${method} returned no output`)
    }
    return payload.output
  }
  return {
    settings: { get: () => call("settings.get"), set: (patch) => call("settings.set", patch) },
    status: { get: () => call("status.get") },
    receipts: { list: () => call("receipts.list") },
  }
}

export const scenarioScript = (name: keyof typeof FAKE_SCENARIOS): FakeProviderScript =>
  FAKE_SCENARIOS[name]
