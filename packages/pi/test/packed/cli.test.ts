// covers: ["ADP-048", "ADP-057", "ADP-064"]
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"

it("loads the built extension in the real offline Pi CLI in text and JSON modes", async () => {
  const root = await mkdtemp(join(tmpdir(), "adaptive-pi-packed-"))
  const agentDir = join(root, "agent")
  try {
    await mkdir(join(agentDir, "adaptive"), { recursive: true })
    const ref = { providerID: "adaptive-faux", id: "local" }
    await writeFile(
      join(agentDir, "adaptive", "settings.json"),
      JSON.stringify({ mode: "active", tiers: { quick: [ref], standard: [ref], advanced: [ref] } }),
    )
    // Pi exposes ESM-only entry points, while Vitest does not implement import.meta.resolve.
    const cli = (
      createRequire(import.meta.url).resolve.paths("@earendil-works/pi-coding-agent") ?? []
    )
      .map((directory) => join(directory, "@earendil-works/pi-coding-agent/dist/cli.js"))
      .find((path) => existsSync(path))
    if (cli === undefined) throw new Error("Installed Pi CLI is missing")
    const extension = fileURLToPath(new URL("../../dist/index.js", import.meta.url))
    const fixture = fileURLToPath(new URL("../fixtures/provider.ts", import.meta.url))
    for (const mode of ["text", "json"]) {
      const result = spawnSync(
        process.execPath,
        [
          cli,
          "--print",
          "--mode",
          mode,
          "--offline",
          "--no-extensions",
          "--no-mcp",
          "--no-skills",
          "--no-prompt-templates",
          "--no-themes",
          "--no-context-files",
          "--no-tools",
          "--no-session",
          "-e",
          extension,
          "-e",
          fixture,
          "--model",
          "adaptive/auto",
          "--",
          "Test",
        ],
        {
          cwd: root,
          env: {
            HOME: root,
            PATH: process.env["PATH"],
            PI_CODING_AGENT_DIR: agentDir,
            PI_TELEMETRY: "false",
            PI_OFFLINE: "1",
          },
          encoding: "utf8",
          timeout: 20000,
        },
      )
      expect(result.stderr).toBe("")
      expect(result.status, result.stdout).toBe(0)
      expect(result.stdout).toContain("ADAPTIVE_PACKED_OK")
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
