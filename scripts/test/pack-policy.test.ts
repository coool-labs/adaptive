import { expect, it } from "vitest"
import {
  exportTargetProblems,
  privateArtifactProblems,
  readPackPolicy,
  runtimeDependencyProblems,
} from "../pack-policy.js"

it("forbids private workspace references in executable code and declarations, not original maps", () => {
  expect(
    privateArtifactProblems("package/dist/index.js", 'import "@coool/adaptive-core/log"'),
  ).toEqual(["package/dist/index.js references private workspace @coool/adaptive-core"])
  expect(
    privateArtifactProblems("package/dist/index.d.ts", 'import "@coool/adaptive-testkit/x"'),
  ).toHaveLength(1)
  expect(privateArtifactProblems("package/dist/index.js", 'import "node:fs"')).toEqual([])
  expect(privateArtifactProblems("package/dist/index.js.map", "@coool/adaptive-core/log")).toEqual(
    [],
  )
})

it("rejects private workspace dependencies in every published npm field", () => {
  for (const field of [
    "devDependencies",
    "dependencies",
    "peerDependencies",
    "optionalDependencies",
    "bundledDependencies",
    "bundleDependencies",
  ]) {
    expect(
      runtimeDependencyProblems({ [field]: { "@coool/adaptive-core": "0.0.0" } }),
    ).toHaveLength(1)
    expect(runtimeDependencyProblems({ [field]: ["@coool/adaptive-testkit"] })).toHaveLength(1)
    expect(runtimeDependencyProblems({ [field]: null })).toEqual([
      `manifest ${field} must be an object or array`,
    ])
  }
})

it("requires each conditional export target to exist in the packed artifact", () => {
  expect(
    exportTargetProblems({ ".": { import: "./dist/index.js", types: "./dist/index.d.ts" } }, [
      "package/dist/index.js",
      "package/dist/index.d.ts",
    ]),
  ).toEqual([])
  expect(exportTargetProblems("./dist/missing.js", [])).toEqual([
    "missing or unsafe export target: ./dist/missing.js",
  ])
  expect(exportTargetProblems("/absolute.js", [])).toHaveLength(1)
  for (const value of [undefined, null, 1])
    expect(exportTargetProblems(value, [])).toEqual(["manifest exports must name file targets"])
})

it("reads required artifacts independently of the host", () => {
  const policy = { name: "@coool/pi-adaptive", requiredFiles: ["package/dist/index.js"] }
  expect(readPackPolicy(policy)).toEqual(policy)
})

it("rejects malformed policy fields and unsafe archive paths", () => {
  for (const value of [
    undefined,
    null,
    [],
    {},
    { name: 1 },
    { name: "" },
    { name: "pi" },
    { name: "pi", requiredFiles: {} },
    { name: "pi", requiredFiles: [] },
    ...[1, "/absolute", "package/../secret", "package/file with spaces"].map((file) => ({
      name: "pi",
      requiredFiles: [file],
    })),
  ])
    expect(() => readPackPolicy(value)).toThrow("pack-manifest.json")
})
