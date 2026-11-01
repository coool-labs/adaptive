// covers: ["ADP-048"]
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { describe, expect, it } from "vitest"

// import.meta.dirname/url are unreliable under vite-node (not file URLs), so
// resolve the repo root by walking up to this package's manifest (the same
// pattern test/runtime-e2e/helpers.ts uses).
const packageJson: unknown = JSON.parse(
  readFileSync(
    ((): string => {
      let dir = process.cwd()
      for (;;) {
        const manifest = join(dir, "package.json")
        if (
          existsSync(manifest) &&
          readFileSync(manifest, "utf8").includes(`"name": "@coool/opencode-adaptive"`)
        ) {
          return manifest
        }
        const parent = dirname(dir)
        if (parent === dir)
          throw new Error("could not locate @coool/opencode-adaptive package root")
        dir = parent
      }
    })(),
    "utf8",
  ),
)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

describe("package publish contract (ADP-048)", () => {
  it("is the adaptive plugin", () => {
    expect(isRecord(packageJson)).toBe(true)
    if (!isRecord(packageJson)) return
    expect(packageJson["name"]).toBe("@coool/opencode-adaptive")
  })

  it("exports the four public entrypoints and nothing else", () => {
    if (!isRecord(packageJson)) return
    const exports = packageJson["exports"]
    expect(isRecord(exports)).toBe(true)
    if (!isRecord(exports)) return
    expect(Object.keys(exports).sort()).toEqual([".", "./gui-experimental", "./rpc", "./tui"])
  })

  it("is MIT-licensed", () => {
    if (!isRecord(packageJson)) return
    expect(packageJson["license"]).toBe("MIT")
  })

  it("keeps runtime dependencies to the pinned minimal set", () => {
    if (!isRecord(packageJson)) return
    expect(packageJson["dependencies"]).toEqual({
      "@opencode/schema": ">=2.2.1 <3",
      "@standard-schema/spec": "^1.0.0",
    })
  })
})
