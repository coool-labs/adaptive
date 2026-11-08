import { expect, it, vi } from "vitest"
import type { AdaptiveSources } from "../src/host/extension.js"

const bindings: {
  read: ReturnType<typeof vi.fn<() => Promise<string>>>
  sources: AdaptiveSources | undefined
} = vi.hoisted(() => ({ read: vi.fn<() => Promise<string>>(), sources: undefined }))
vi.mock("node:fs/promises", () => ({ readFile: bindings.read }))
vi.mock("../src/host/extension.js", () => ({
  registerAdaptive: (_pi: unknown, sources: AdaptiveSources) => {
    bindings.sources = sources
  },
}))
import adaptive from "../src/index.js"

it("loads defaults only for a missing file and rejects malformed settings with field feedback", async () => {
  adaptive({
    registerVirtualModel: vi.fn(),
    getActiveTools: () => [],
    registerTool: vi.fn(),
    on: vi.fn(),
    sendMessage: vi.fn(),
  })
  const sources = bindings.sources
  if (sources === undefined) throw new Error("binding missing")
  expect(sources.newId()).toMatch(/^[0-9a-f-]{36}$/)
  expect(sources.newId()).not.toBe(sources.newId())
  bindings.read.mockResolvedValueOnce('{"models":[]}')
  expect(await sources.capabilities()).toEqual([])
  const load = sources.settings
  bindings.read.mockRejectedValueOnce(Object.assign(new Error("missing"), { code: "ENOENT" }))
  expect((await load()).mode).toBe("observe")
  bindings.read.mockResolvedValueOnce('{"mode":"active"}')
  expect((await load()).mode).toBe("active")
  bindings.read.mockResolvedValueOnce('{"mode":"broken"}')
  await expect(load()).rejects.toThrow("invalid mode")
  bindings.read.mockResolvedValueOnce("not json")
  await expect(load()).rejects.toThrow("Adaptive settings: invalid JSON")
  for (const failure of [
    new Error("denied"),
    Object.assign(new Error("denied"), { code: "EACCES" }),
    "failure",
  ]) {
    bindings.read.mockRejectedValueOnce(failure)
    await expect(load()).rejects.toBe(failure)
  }
})
