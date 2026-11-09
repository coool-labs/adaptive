// covers: ["ADP-050"]
// Publishes one plugin from its checked-out manifest and certifies the result
// with the post-publication tag (`opencode-vX.Y.Z` / `pi-vX.Y.Z`), pushed only
// after the registry accepted the version. Recoverable with release --resume.
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { executePublish } from "./publish/execute.js"
import { planPublish } from "./publish/plan.js"
import { PLUGINS, publishState } from "./release/plan.js"

function capture(command: string, args: readonly string[]): string {
  const result = spawnSync(command, args, { encoding: "utf8" })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")}: ${result.stderr.trim()}`)
  return result.stdout.trim()
}

function run(command: string, args: readonly string[]): void {
  const result = spawnSync(command, args, { stdio: "inherit" })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")}: failed`)
}

function property(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined
  return Object.getOwnPropertyDescriptor(value, key)?.value
}

function main(id: string): void {
  const plugin = PLUGINS.find((candidate) => candidate === id)
  if (plugin === undefined) {
    throw new Error(
      `publish: expected package ${PLUGINS.join(" or ")}, received ${id || "nothing"}`,
    )
  }
  const file = `packages/${id}/package.json`
  if (!existsSync(file)) throw new Error(`publish: ${file} not found`)
  const manifest: unknown = JSON.parse(readFileSync(file, "utf8"))
  const name = property(manifest, "name")
  const version = property(manifest, "version")
  if (typeof name !== "string" || typeof version !== "string") {
    throw new Error(`${file}: name and version must be strings`)
  }
  // The published version and its tag both come from this manifest; a clean
  // tree guarantees it is the committed state, not a local drift.
  if (capture("git", ["status", "--porcelain"]).length !== 0) {
    throw new Error("publish: working tree must be clean")
  }
  if (capture("git", ["branch", "--show-current"]) !== "main") {
    throw new Error("publish: switch to main first")
  }
  capture("npm", ["whoami"])
  const target = planPublish({
    id: plugin,
    name,
    version,
    private: property(manifest, "private") === true,
  })
  const actions = executePublish(target, {
    registryState() {
      const result = spawnSync("npm", ["view", `${target.name}@${target.version}`, "version"], {
        encoding: "utf8",
      })
      if (result.error !== undefined) throw result.error
      return publishState(result)
    },
    localTag() {
      const tags = capture("git", ["tag", "--list"]).split("\n")
      if (!tags.includes(target.tag)) return "absent"
      return capture("git", ["rev-parse", `${target.tag}^{commit}`]) ===
        capture("git", ["rev-parse", "HEAD"])
        ? "on-head"
        : "detached"
    },
    publish() {
      run("npm", ["publish", "--workspace", `packages/${target.id}`, "--access", "public"])
    },
    createTag() {
      run("git", ["tag", "-a", target.tag, "-m", target.tag])
    },
    pushTag() {
      run("git", ["push", "origin", target.tag])
    },
  })
  if (!actions.includes("publish")) {
    console.log(`publish: ${target.name}@${target.version} is already in the registry`)
  }
  console.log(`publish: ${target.name}@${target.version} certified as ${target.tag} and pushed`)
}

try {
  main(process.argv[2] ?? "")
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
