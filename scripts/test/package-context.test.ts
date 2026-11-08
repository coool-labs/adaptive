import { describe, expect, it } from "vitest"
import { packageContext } from "../package-context.js"

describe("package command scope", () => {
  const exists = (path: string): boolean =>
    [
      "/repo/package-lock.json",
      "/repo/packages/opencode/package.json",
      "/repo/packages/pi/package.json",
    ].includes(path)

  it("resolves an explicit plugin from the root or nested directory", () => {
    expect(packageContext(["--pkg", "opencode"], "/repo", exists)).toEqual({
      workspace: "opencode",
      root: "/repo",
      directory: "/repo/packages/opencode",
    })
    expect(packageContext(["--pkg", "pi"], "/repo/packages/pi/test", exists)).toEqual({
      workspace: "pi",
      root: "/repo",
      directory: "/repo/packages/pi",
    })
  })

  it.each([[], ["--pkg"], ["--all", "opencode"], ["--pkg", "core"], ["--pkg", "pi", "extra"]])(
    "rejects ambiguous or unsupported arguments: %j",
    (...args) => {
      expect(() => packageContext(args, "/repo", exists)).toThrow("Expected --pkg")
    },
  )

  it("names the missing root or package", () => {
    expect(() => packageContext(["--pkg", "pi"], "/elsewhere", () => false)).toThrow(
      "workspace root",
    )
    expect(() =>
      packageContext(["--pkg", "pi"], "/repo", (path) => path === "/repo/package-lock.json"),
    ).toThrow("Package pi does not exist")
  })
})
