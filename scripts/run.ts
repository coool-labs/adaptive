// covers: ["ADP-050"]
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { affectedWorkspaces, type Workspace } from "./affected.js"
import { parseCheckOptions, planChecks } from "./check-plan.js"
import { executeChecks } from "./check-runner.js"

const ADDON_FIX = 'PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" npm install'

function readScripts(workspace: Workspace): string[] {
  const value: unknown = JSON.parse(readFileSync(`packages/${workspace}/package.json`, "utf8"))
  if (typeof value !== "object" || value === null || !("scripts" in value)) {
    throw new Error(`packages/${workspace}/package.json: scripts must be an object`)
  }
  if (typeof value.scripts !== "object" || value.scripts === null || Array.isArray(value.scripts)) {
    throw new Error(`packages/${workspace}/package.json: scripts must be an object`)
  }
  if (Object.values(value.scripts).some((script) => typeof script !== "string")) {
    throw new Error(`packages/${workspace}/package.json: script values must be strings`)
  }
  return Object.keys(value.scripts)
}

function gitPaths(args: string[]): string[] {
  const result = spawnSync("git", args, { encoding: "utf8" })
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`)
  return result.stdout.split("\0").filter((path) => path.length > 0)
}

try {
  const known: Workspace[] = ["core", "testkit", "opencode", "pi"]
  const available = known.filter((workspace) => existsSync(`packages/${workspace}/package.json`))
  const options = parseCheckOptions(process.argv.slice(2), available)
  let selected = options.packages
  if (options.all) selected = available
  else if (selected.length === 0) {
    selected = affectedWorkspaces(
      [
        ...gitPaths(["diff", "--name-only", "--no-renames", "-z", "main...HEAD"]),
        ...gitPaths(["diff", "--name-only", "--no-renames", "-z", "HEAD"]),
        ...gitPaths(["ls-files", "--others", "--exclude-standard", "-z"]),
      ],
      available,
    )
  }
  const scripts = {
    core: available.includes("core") ? readScripts("core") : [],
    testkit: available.includes("testkit") ? readScripts("testkit") : [],
    opencode: available.includes("opencode") ? readScripts("opencode") : [],
    pi: available.includes("pi") ? readScripts("pi") : [],
  }
  const steps = planChecks(options, selected, scripts)
  const succeeded = executeChecks(options.command, steps, selected, options.skip, {
    execute(step) {
      const args = ["run", step.script]
      if (step.workspace !== "root") args.push("--workspace", `packages/${step.workspace}`)
      const env = { ...process.env }
      if (step.script === "e2e:tui") {
        const node24 = join(process.env["HOME"] ?? "", ".nvm/versions/node/v24.15.0/bin")
        if (!existsSync(join(node24, "node"))) {
          return {
            status: 1,
            output: "TUI tests need Node 24. Install nvm Node 24.15.0, then run npm run doctor.",
            milliseconds: 0,
          }
        }
        // npm on Node 26 silently drops the Node 24-only optional PTY addon on
        // every install; without it each TUI test times out one by one.
        try {
          createRequire(import.meta.url).resolve(
            `@termwright/pty-${process.platform}-${process.arch}/termwright_pty.node`,
          )
        } catch {
          return {
            status: 1,
            output: `TUI native addon missing. Run: ${ADDON_FIX}`,
            milliseconds: 0,
          }
        }
        env["PATH"] = `${node24}:${env["PATH"] ?? ""}`
      }
      const start = performance.now()
      const result = spawnSync("npm", args, { encoding: "utf8", env, maxBuffer: 32 * 1024 * 1024 })
      return {
        status: result.status ?? 1,
        output: `${result.stdout}${result.stderr}${result.error?.message ?? ""}`,
        milliseconds: performance.now() - start,
      }
    },
    saveLog(path, output) {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, output)
    },
    print(message) {
      console.log(message)
    },
  })
  process.exitCode = succeeded ? 0 : 1
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
