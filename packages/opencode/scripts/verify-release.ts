// covers: ["ADP-050"]
/**
 * Publish-readiness gate (ADP-050): runs the complete local verification
 * pipeline in one command, aborting at the first failing step. Run via
 * `npm run verify:release`.
 */
import { spawnSync } from "node:child_process"

// Formatting and lint gates are repo-wide and live in the workspace root.
const ROOT_STEPS = new Set(["format:check", "lint", "lint:biome"])
const STEPS = [
  "format:check",
  "lint",
  "lint:biome",
  "typecheck",
  // runtime E2E (part of `test`) loads the plugin from dist/, so build first.
  "build",
  "test",
  "coverage",
  "pack:check",
  "plugin-test",
  "e2e:gui",
  "e2e:web",
  "e2e:tui",
  "traceability",
] as const

for (const step of STEPS) {
  console.log(`verify:release: npm run ${step}`)
  // termwright (e2e:tui) certifies Node 22/24; on newer Node runtimes the PTY
  // backend is run through an explicitly prefixed nvm Node 24 installation.
  const env =
    step === "e2e:tui" && Number.parseInt(process.version.slice(1), 10) >= 26
      ? {
          ...process.env,
          PATH: `${process.env["HOME"] ?? ""}/.nvm/versions/node/v24.15.0/bin:${process.env["PATH"] ?? ""}`,
        }
      : process.env
  const args = ROOT_STEPS.has(step) ? ["--prefix", "../..", "run", step] : ["run", step]
  const result = spawnSync("npm", args, { stdio: "inherit", env })
  if (result.error !== undefined || result.status !== 0) {
    const detail =
      result.error !== undefined ? result.error.message : `exit code ${String(result.status)}`
    console.error(`verify:release: FAILED at "npm run ${step}" (${detail})`)
    process.exit(1)
  }
}
console.log("verify:release: all gates passed")
