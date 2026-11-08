import { expect, it } from "vitest"
import { readPackPolicy } from "../pack-policy.js"

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
