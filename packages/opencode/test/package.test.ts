// covers: ["ADP-048"]
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import ts from "typescript"
import { REPO_ROOT, WORKSPACE_ROOT } from "./runtime-e2e/helpers.js"

const packageJson: unknown = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"))

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

  it("leaves platform-specific PTY selection to termwright's optional dependencies", () => {
    if (!isRecord(packageJson)) return
    const devDependencies = packageJson["devDependencies"]
    expect(isRecord(devDependencies)).toBe(true)
    if (!isRecord(devDependencies)) return
    expect(devDependencies).not.toHaveProperty("@termwright/pty-darwin-arm64")
    const lock: unknown = JSON.parse(
      readFileSync(join(WORKSPACE_ROOT, "package-lock.json"), "utf8"),
    )
    expect(lock).toHaveProperty(
      ["packages", "node_modules/@termwright/pty-darwin-arm64", "optional"],
      true,
    )
    expect(lock).not.toHaveProperty([
      "packages",
      "",
      "devDependencies",
      "@termwright/pty-darwin-arm64",
    ])
  })

  it("removes stale artifacts before building, including on repeated clean builds", () => {
    if (!isRecord(packageJson)) return
    const scripts = packageJson["scripts"]
    expect(isRecord(scripts)).toBe(true)
    if (!isRecord(scripts)) return
    expect(typeof scripts["prebuild"]).toBe("string")
    const dir = mkdtempSync(join(tmpdir(), "adaptive-clean-test-"))
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts }))
      mkdirSync(join(dir, "dist/nested"), { recursive: true })
      writeFileSync(join(dir, "dist/nested/deleted.js"), "stale")
      writeFileSync(join(dir, "keep.txt"), "workspace")
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = spawnSync("npm", ["run", "prebuild"], { cwd: dir, encoding: "utf8" })
        expect(result.stderr).toBe("")
        expect(result.status).toBe(0)
        expect(existsSync(join(dir, "dist"))).toBe(false)
        expect(readFileSync(join(dir, "keep.txt"), "utf8")).toBe("workspace")
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("embeds original sources in JavaScript maps without dangling declaration maps", () => {
    const config = ts.readConfigFile(join(REPO_ROOT, "tsconfig.build.json"), (path) =>
      ts.sys.readFile(path),
    )
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, REPO_ROOT)
    expect(parsed.errors).toEqual([])
    const source = "export const packaged = 42\n"
    const output = ts.transpileModule(source, {
      compilerOptions: parsed.options,
      fileName: "src/packaging-fixture.ts",
    })
    const map: unknown = JSON.parse(output.sourceMapText ?? "null")
    expect(map).toHaveProperty("sourcesContent", [source])
    expect(parsed.options.declarationMap).not.toBe(true)

    // Exercise npm's actual file selection without touching the shared build output.
    const dir = mkdtempSync(join(tmpdir(), "adaptive-pack-test-"))
    try {
      if (!isRecord(packageJson)) throw new Error("package.json must be a record")
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          name: "adaptive-packaging-fixture",
          version: "1.0.0",
          files: packageJson["files"],
        }),
      )
      mkdirSync(join(dir, "dist"))
      mkdirSync(join(dir, "src"))
      writeFileSync(join(dir, "src/packaging-fixture.ts"), source)
      writeFileSync(join(dir, "dist/packaging-fixture.js"), output.outputText)
      writeFileSync(join(dir, "dist/packaging-fixture.js.map"), output.sourceMapText ?? "")
      const pack = spawnSync("npm", ["pack", "--ignore-scripts", "--offline"], {
        cwd: dir,
        encoding: "utf8",
      })
      expect(pack.status, pack.stderr).toBe(0)
      const tarball = join(dir, "adaptive-packaging-fixture-1.0.0.tgz")
      const listing = spawnSync("tar", ["-tzf", tarball], { encoding: "utf8" })
      expect(listing.status, listing.stderr).toBe(0)
      expect(listing.stdout).not.toContain("package/src/")
      const extracted = spawnSync(
        "tar",
        ["-xzOf", tarball, "package/dist/packaging-fixture.js.map"],
        { encoding: "utf8" },
      )
      expect(extracted.status, extracted.stderr).toBe(0)
      const packedMap: unknown = JSON.parse(extracted.stdout)
      expect(packedMap).toHaveProperty("sourcesContent", [source])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
