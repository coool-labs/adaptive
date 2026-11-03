// covers: ["ADP-048"]
/**
 * Pack validation (ADP-048): builds a real tarball with `npm pack`, inspects
 * its contents (required entrypoints present, no stray sources), and runs
 * `npm publish --dry-run`. Run via `npm run pack:check` —
 * `verify:release` gates on it.
 */
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const REQUIRED_FILES = [
  "package/package.json",
  "package/README.md",
  "package/LICENSE",
  "package/dist/index.js",
  "package/dist/index.d.ts",
  "package/dist/tui.js",
  "package/dist/tui.d.ts",
  "package/dist/rpc.js",
  "package/dist/rpc.d.ts",
  "package/dist/gui-experimental.cjs",
]

/** Anything shipped in the tarball that is not part of the published artifact. */
const FORBIDDEN = [
  /^package\/(src|test|docs|scripts)\//,
  /node_modules/,
  /GOAL\.md/,
  /coverage\//,
  /\.d\.ts\.map$/,
]

function run(command: string, args: readonly string[], env?: NodeJS.ProcessEnv): string {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    env: env ?? process.env,
  })
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (exit ${String(result.status)}): ${result.stderr}`,
    )
  }
  return result.stdout
}

const dir = mkdtempSync(join(tmpdir(), "adaptive-pack-"))
try {
  const out = run("npm", ["pack", "--pack-destination", dir])
  const tarball = out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .at(-1)
  if (tarball === undefined) throw new Error("npm pack produced no tarball path")
  if (!tarball.endsWith(".tgz")) throw new Error(`unexpected pack output: ${tarball}`)
  // npm pack prints the tarball name relative to the destination directory.
  const tarballPath = tarball.includes("/") ? tarball : join(dir, tarball)

  const listing = run("tar", ["-tzf", tarballPath])
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  const problems: string[] = []
  for (const required of REQUIRED_FILES) {
    if (!listing.includes(required)) problems.push(`missing tarball file: ${required}`)
  }
  for (const entry of listing) {
    if (FORBIDDEN.some((pattern) => pattern.test(entry))) {
      problems.push(`forbidden tarball file: ${entry}`)
    }
    if (entry.endsWith(".js.map")) {
      const map: unknown = JSON.parse(run("tar", ["-xzOf", tarballPath, entry]))
      if (
        typeof map !== "object" ||
        map === null ||
        !("sources" in map) ||
        !Array.isArray(map.sources) ||
        !("sourcesContent" in map) ||
        !Array.isArray(map.sourcesContent) ||
        map.sourcesContent.length !== map.sources.length ||
        !map.sourcesContent.every((source: unknown) => typeof source === "string")
      ) {
        problems.push(`source map is missing embedded sources: ${entry}`)
      }
    }
  }

  const manifestText = run("tar", ["-xzOf", tarballPath, "package/package.json"])
  const manifest: unknown = JSON.parse(manifestText)
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    Array.isArray(manifest) ||
    !("name" in manifest) ||
    !("version" in manifest) ||
    !("license" in manifest)
  ) {
    throw new Error("tarball package.json is not a record with name/version/license")
  }
  if (manifest.name !== "@coool/opencode-adaptive") {
    problems.push(`manifest name is ${String(manifest.name)}`)
  }
  if (typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+/.test(manifest.version)) {
    problems.push(`manifest version is not semver: ${String(manifest.version)}`)
  }
  if (manifest.license !== "MIT") problems.push(`manifest license is ${String(manifest.license)}`)

  if (problems.length > 0) {
    for (const problem of problems) console.error(`pack:check: ${problem}`)
    process.exit(1)
  }

  // The publish dry-run packs again and applies npm's own publication checks
  // without contacting the registry.
  run("npm", ["publish", "--dry-run"], { ...process.env, npm_config_dry_run: "true" })

  const report = { tarball: tarballPath, entries: listing.length, required: REQUIRED_FILES.length }
  mkdirSync("test-artifacts", { recursive: true })
  writeFileSync(join("test-artifacts", "pack-check.json"), `${JSON.stringify(report, null, 2)}\n`)
  console.log(`pack:check: tarball OK (${String(report.entries)} entries) — publish dry-run OK`)
} finally {
  rmSync(dir, { recursive: true, force: true })
}
