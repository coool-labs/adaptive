// covers: ["ADP-017"]
import { expect, it, vi } from "vitest"
import { loadToolCapabilities } from "../src/capabilities.js"

it("loads explicit tool declarations without coercion or guessing", async () => {
  const models = [
    { providerID: "p", id: "yes", tools: true },
    { providerID: "p", id: "no", tools: false },
  ]
  expect(
    await loadToolCapabilities("capabilities.json", (path) => {
      expect(path).toBe("capabilities.json")
      return Promise.resolve(JSON.stringify({ models }))
    }),
  ).toEqual(models)
  expect(await loadToolCapabilities("unused", () => Promise.resolve('{"models":[]}'))).toEqual([])
})

it("treats only ENOENT as undeclared capabilities", async () => {
  expect(
    await loadToolCapabilities("unused", () =>
      Promise.reject(Object.assign(new Error("missing"), { code: "ENOENT" })),
    ),
  ).toEqual([])
  for (const error of [
    new Error("denied"),
    Object.assign(new Error("denied"), { code: "EACCES" }),
    "failure",
  ]) {
    const read = vi.fn<() => Promise<string>>().mockRejectedValue(error)
    await expect(loadToolCapabilities("unused", read)).rejects.toBe(error)
  }
})

it("rejects malformed declarations with the exact offending field", async () => {
  const valid = { providerID: "p", id: "m", tools: true }
  const malformed: [unknown, string][] = [
    [null, "models"],
    [[], "models"],
    [{}, "models"],
    [{ models: [], extra: true }, "models"],
    [{ models: [null] }, "models[0]"],
    ...[undefined, " ", 1].map((providerID): [unknown, string] => [
      { models: [{ ...valid, providerID }] },
      "models[0].providerID",
    ]),
    ...[undefined, " ", 1].map((id): [unknown, string] => [
      { models: [{ ...valid, id }] },
      "models[0].id",
    ]),
    [{ models: [{ ...valid, tools: "true" }] }, "models[0].tools"],
    [{ models: [{ ...valid, secret: "must-not-echo" }] }, "unknown field"],
    [{ models: [valid, valid] }, "duplicate model"],
  ]
  for (const [raw, field] of malformed) {
    await expect(
      loadToolCapabilities("unused", () => Promise.resolve(JSON.stringify(raw))),
    ).rejects.toThrow(field)
  }
  await expect(
    loadToolCapabilities("unused", () => Promise.resolve("not-json-secret")),
  ).rejects.toThrow("Adaptive capabilities: invalid JSON")
})
