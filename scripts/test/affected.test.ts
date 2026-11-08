import { describe, expect, it } from "vitest"
import { affectedWorkspaces } from "../affected.js"

describe("affected workspaces", () => {
  const available = ["core", "testkit", "opencode", "pi"] as const

  it("does not select workspaces without changes", () => {
    expect(affectedWorkspaces([], available)).toEqual([])
  })

  it("selects only the changed plugin and deduplicates paths", () => {
    expect(
      affectedWorkspaces(["packages/pi/src/index.ts", "packages/pi/test/a.ts"], available),
    ).toEqual(["pi"])
    expect(affectedWorkspaces(["packages/opencode/src/index.ts"], available)).toEqual(["opencode"])
  })

  it.each(["core", "testkit"])("invalidates consumers when %s changes", (workspace) => {
    expect(affectedWorkspaces([`packages/${workspace}/src/index.ts`], available)).toEqual(available)
  })

  it("invalidates all workspaces for root tooling, configuration, and docs", () => {
    for (const path of ["scripts/run.ts", "package-lock.json", "docs/PRODUCT.md"]) {
      expect(affectedWorkspaces([path], available)).toEqual(available)
    }
  })

  it("normalizes Windows paths and ignores packages not present locally", () => {
    expect(affectedWorkspaces(["packages\\pi\\src\\index.ts"], available)).toEqual(["pi"])
    expect(affectedWorkspaces(["packages/pi/src/index.ts"], ["opencode"])).toEqual([])
    expect(affectedWorkspaces(["packages/unknown/src/index.ts"], available)).toEqual([])
  })
})
