import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  copyFileSync,
  symlinkSync,
} from "node:fs"
import { createServer } from "node:http"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { exercisePicker } from "../packages/pi/test/tui/picker.spec.js"
import { exerciseJson } from "../packages/pi/test/matrix/json.spec.js"
import {
  assertSupportedPi,
  parsePiMatrix,
  piBaseline,
  testedPiVersion,
  type PiMatrixPass,
} from "./pi-matrix-policy.js"

const root = resolve(import.meta.dirname, "..")
const workspace = join(root, "packages/pi")
const artifacts = join(root, "test-artifacts/pi-matrix")
mkdirSync(artifacts, { recursive: true })
// Never leave a previous successful claim looking like evidence for a failed new run.
writeFileSync(
  join(artifacts, "evidence.json"),
  `${JSON.stringify({ result: "RUNNING", generatedAt: new Date().toISOString() })}\n`,
)
const matrix = parsePiMatrix(
  JSON.parse(readFileSync(join(workspace, "pi-host-matrix.json"), "utf8")),
)
const node =
  Number(process.versions.node.split(".")[0]) === matrix.nodeMajor
    ? process.execPath
    : join(homedir(), ".nvm/versions/node/v24.15.0/bin/node")
assert.ok(existsSync(node), "Pi matrix requires Node 24; run npm run doctor")
const baseEnv: Record<string, string> = {
  PATH: `${dirname(node)}:${process.env["PATH"] ?? ""}`,
  HOME: homedir(),
  TERM: "xterm-256color",
  LANG: "en_US.UTF-8",
  PI_OFFLINE: "1",
  PI_TELEMETRY: "false",
  npm_config_update_notifier: "false",
  ...(process.env["TMPDIR"] === undefined ? {} : { TMPDIR: process.env["TMPDIR"] }),
}

async function run(
  command: string,
  args: string[],
  cwd: string,
  env = baseEnv,
  timeout = 180_000,
): Promise<string> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] })
    let output = ""
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
    }, timeout)
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString()
    })
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString()
    })
    child.on("error", reject)
    child.on("close", (code) => {
      clearTimeout(timer)
      if (code !== 0)
        reject(new Error(`${command} ${args.join(" ")} exited ${String(code)}\n${output}`))
      else resolveRun(output)
    })
  })
}

function packageVersion(directory: string): string {
  const raw: unknown = JSON.parse(
    readFileSync(
      join(directory, "node_modules/@earendil-works/pi-coding-agent/package.json"),
      "utf8",
    ),
  )
  assert.ok(
    typeof raw === "object" && raw !== null && "version" in raw && typeof raw.version === "string",
    "host package.version missing",
  )
  return raw.version
}

async function host(version: string): Promise<string> {
  const spike = join(homedir(), ".cache/adaptive-pi-spike")
  if (
    version === matrix.minimum &&
    existsSync(join(spike, "node_modules/@earendil-works/pi-coding-agent/package.json")) &&
    packageVersion(spike) === version
  )
    return spike
  const directory = join(homedir(), ".cache/adaptive-pi-matrix", version)
  mkdirSync(directory, { recursive: true })
  if (!existsSync(join(directory, "node_modules/@earendil-works/pi-coding-agent/package.json"))) {
    writeFileSync(join(directory, "package.json"), '{"private":true,"type":"module"}\n')
    const output = await run(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--registry=https://registry.npmjs.org",
        `@earendil-works/pi-coding-agent@${version}`,
        `@earendil-works/pi-ai@${version}`,
      ],
      directory,
    )
    writeFileSync(join(artifacts, `host-${version}-install.log`), output)
  }
  assert.equal(packageVersion(directory), version)
  return directory
}

function manifests(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return manifests(path)
    if (entry.name !== "package.json") return []
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"))
    return typeof raw === "object" && raw !== null && "name" in raw && typeof raw.name === "string"
      ? [raw.name]
      : []
  })
}

const manifest: unknown = JSON.parse(readFileSync(join(workspace, "package.json"), "utf8"))
assert.ok(
  typeof manifest === "object" &&
    manifest !== null &&
    "name" in manifest &&
    typeof manifest.name === "string" &&
    "version" in manifest &&
    typeof manifest.version === "string",
)
const name = manifest.name
const version = manifest.version
const packOutput = await run(
  "npm",
  ["pack", "--json", "--ignore-scripts", "--pack-destination", artifacts],
  workspace,
)
const packed: unknown = JSON.parse(packOutput)
assert.ok(Array.isArray(packed) && packed.length === 1)
const pack: unknown = packed[0]
assert.ok(
  typeof pack === "object" &&
    pack !== null &&
    "filename" in pack &&
    typeof pack.filename === "string",
)
const archive = readFileSync(join(artifacts, pack.filename))
const integrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`
const requests: string[] = []
let registry = ""
const server = createServer((request, response) => {
  const path = request.url ?? ""
  requests.push(path)
  if (path === "/adaptive.tgz") {
    response.end(archive)
    return
  }
  if (decodeURIComponent(path).replace(/^\//, "") === name) {
    response.setHeader("content-type", "application/json")
    response.end(
      JSON.stringify({
        name,
        "dist-tags": { latest: version },
        versions: {
          [version]: { ...manifest, dist: { tarball: `${registry}/adaptive.tgz`, integrity } },
        },
      }),
    )
    return
  }
  response.writeHead(404)
  response.end(JSON.stringify({ error: "Unexpected request; host peers must stay optional" }))
})
await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen))
const address = server.address()
assert.ok(address !== null && typeof address !== "string")
registry = `http://127.0.0.1:${String(address.port)}`
const passed: PiMatrixPass[] = []
const resolved: string[] = []
const report: { result: string; testedUpTo?: string; error?: string } = { result: "FAIL" }

try {
  assert.equal((await run(node, ["-p", "process.versions.node.split('.')[0]"], root)).trim(), "24")
  for (const requested of matrix.versions) {
    // Resolve latest on every explicit matrix invocation, never silently substitute a stale cache.
    const actual =
      requested === "latest"
        ? (
            await run(
              "npm",
              [
                "view",
                "@earendil-works/pi-coding-agent@latest",
                "version",
                "--registry=https://registry.npmjs.org",
              ],
              root,
            )
          ).trim()
        : requested
    assertSupportedPi(actual, matrix.minimum)
    resolved.push(actual)
    const hostDir = await host(actual)
    const cli = join(hostDir, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js")
    assert.equal((await run(node, [cli, "--version"], root)).trim(), actual)
    const directory = join(artifacts, `${requested}-${actual}-${String(Date.now())}`)
    mkdirSync(directory, { recursive: true })
    const agentDir = join(directory, "agent")
    mkdirSync(join(agentDir, "adaptive"), { recursive: true })
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({
        defaultProvider: "adaptive",
        defaultModel: "auto",
        retry: { enabled: true, baseDelayMs: 1, maxRetries: 2 },
        compaction: { enabled: false },
      }),
    )
    const env = {
      ...baseEnv,
      HOME: directory,
      PI_CODING_AGENT_DIR: agentDir,
      npm_config_registry: registry,
      npm_config_cache: join(directory, "npm-cache"),
      PI_MATRIX_TRACE: join(directory, "trace.jsonl"),
    }
    writeFileSync(env.PI_MATRIX_TRACE, "")
    const tiers = Object.fromEntries(
      ["quick", "standard", "advanced"].map((tier) => [
        tier,
        (tier === "standard" ? [tier, "standard-b"] : [tier]).map((id) => ({
          providerID: "adaptive-faux",
          id,
        })),
      ]),
    )
    writeFileSync(
      join(agentDir, "adaptive/settings.json"),
      JSON.stringify({ mode: "active", inviteDismissed: true, tiers }),
    )
    writeFileSync(
      join(agentDir, "adaptive/capabilities.json"),
      JSON.stringify({
        models: ["quick", "standard", "standard-b", "advanced", "manual-physical"].map((id) => ({
          providerID: "adaptive-faux",
          id,
          tools: true,
        })),
      }),
    )
    const start = requests.length
    const install = await run(node, [cli, "install", `npm:${name}@${version}`], directory, env)
    writeFileSync(join(directory, "packed-install.log"), install)
    const fetched = requests.slice(start)
    assert.ok(fetched.includes("/adaptive.tgz"), "Pi install did not fetch the packed artifact")
    assert.ok(
      fetched.every((path) => !path.includes("earendil")),
      `duplicate host request: ${JSON.stringify(fetched)}`,
    )
    const installed = manifests(agentDir)
    assert.ok(installed.includes(name), "packed artifact not installed")
    assert.ok(
      installed.every((entry) => !entry.startsWith("@earendil-works/")),
      "optional peers installed duplicate host",
    )
    writeFileSync(
      join(directory, "packed-install-evidence.json"),
      `${JSON.stringify({ requested, version: actual, requests: fetched, installed, duplicateHost: false, integrity }, null, 2)}\n`,
    )
    const extension = join(agentDir, "npm/node_modules/@coool/pi-adaptive/dist/index.js")
    assert.ok(existsSync(extension), `installed extension missing: ${extension}`)
    symlinkSync(join(hostDir, "node_modules"), join(directory, "node_modules"), "dir")
    const fixture = join(directory, "faux-extension.ts")
    copyFileSync(join(workspace, "test/packed/faux-extension.ts"), fixture)
    const sdk = join(directory, "sdk.ts")
    copyFileSync(join(workspace, "test/packed/sdk.spec.ts"), sdk)
    writeFileSync(join(directory, "package.json"), '{"private":true,"type":"module"}\n')
    const sdkOutput = await run(node, [sdk], directory, { ...env, PI_MATRIX_EXTENSION: extension })
    writeFileSync(join(directory, "sdk.log"), sdkOutput)
    passed.push({ requested, version: actual, surface: "sdk" })
    console.log(`Pi ${requested} (${actual}) sdk PASS`)

    await exerciseJson({ node, cli, cwd: directory, agentDir, fixture, env, run })
    passed.push({ requested, version: actual, surface: "json" })
    console.log(`Pi ${requested} (${actual}) json PASS`)
    writeFileSync(env.PI_MATRIX_TRACE, "")
    await exercisePicker({
      node,
      cli,
      cwd: directory,
      env,
      fixture,
      screenshot: join(directory, "tui-screen.txt"),
    })
    passed.push({ requested, version: actual, surface: "tui" })
    console.log(`Pi ${requested} (${actual}) tui PASS`)
  }
  report.testedUpTo = testedPiVersion(matrix, resolved, passed)
  const baseline = piBaseline(
    matrix,
    resolved,
    passed,
    { version, filename: pack.filename, integrity },
    new Date().toISOString(),
  )
  // Promotion is a source change for the next build, never part of a running verify.
  writeFileSync(
    join(artifacts, "baseline-candidate.json"),
    `${JSON.stringify(baseline, null, 2)}\n`,
  )
  report.result = "PASS"
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error)
  throw error
} finally {
  await new Promise<void>((resolveClose) =>
    server.close(() => {
      resolveClose()
    }),
  )
  writeFileSync(
    join(artifacts, "evidence.json"),
    `${JSON.stringify({ ...report, minimum: matrix.minimum, requested: matrix.versions, resolved, passed, artifact: { filename: pack.filename, integrity }, generatedAt: new Date().toISOString(), hostNode: node, runnerNode: process.versions.node, optionalExclusions: ["Opt-in paid-provider error capture is not run; golden corpus inspection remains the deterministic gate."], pendingMilestones: ["M6 command/onboarding/status/shortcut and M4 packed all-down/parking journeys remain; this is not milestone completion evidence."] }, null, 2)}\n`,
  )
}
