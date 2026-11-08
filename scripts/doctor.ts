import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import { join } from "node:path"

const failures: string[] = []
function report(name: string, available: boolean, detail: string): void {
  console.log(`${available ? "✓" : "✗"} ${name}: ${detail}`)
  if (!available) failures.push(name)
}

const major = Number(process.versions.node.split(".")[0])
const minor = Number(process.versions.node.split(".")[1])
report(
  "Node",
  major > 26 || (major === 26 && minor >= 4),
  `${process.version} (OpenCode tooling needs >=26.4)`,
)
report("dependencies", existsSync("node_modules/.package-lock.json"), "run npm install if missing")
const node24 = join(process.env["HOME"] ?? "", ".nvm/versions/node/v24.15.0/bin/node")
report("TUI Node 24", existsSync(node24), node24)
const require = createRequire(import.meta.url)
try {
  require.resolve(`@termwright/pty-${process.platform}-${process.arch}/termwright_pty.node`)
  report("TUI native addon", true, `${process.platform}-${process.arch}`)
} catch {
  report("TUI native addon", false, "install dependencies under Node 24 (see CONTRIBUTING.md)")
}
const hosts: readonly (readonly [string, string])[] = [
  ["OpenCode", process.env["OPENCODE_BIN"] ?? "/opt/homebrew/bin/opencode"],
  ["Pi", "pi"],
]
for (const [name, binary] of hosts) {
  const result = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 10_000 })
  const detail = result.status === 0 ? result.stdout.trim() : "not installed"
  // Pi is optional until its workspace exists; an old global CLI is not used for SDK tests.
  if (name === "Pi" && !existsSync("packages/pi/package.json"))
    console.log(`– Pi (optional): ${detail}`)
  else report(name, result.status === 0, detail)
}
process.exitCode = failures.length > 0 ? 1 : 0
