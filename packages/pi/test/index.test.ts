import { expect, it, vi } from "vitest"
import type { AdaptiveSources } from "../src/host/extension.js"

const bindings: {
  read: ReturnType<typeof vi.fn<() => Promise<string>>>
  sources: AdaptiveSources | undefined
  host: unknown
} = vi.hoisted(() => ({
  read: vi.fn<() => Promise<string>>(),
  sources: undefined,
  host: undefined,
}))
vi.mock("node:fs/promises", () => ({ readFile: bindings.read }))
vi.mock("../src/host/extension.js", () => ({
  registerAdaptive: (_pi: unknown, sources: AdaptiveSources, host: unknown) => {
    bindings.sources = sources
    bindings.host = host
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
    sendUserMessage: vi.fn(),
    appendEntry: vi.fn(),
    registerCommand: vi.fn(),
    registerShortcut: vi.fn(),
    setModel: vi.fn(),
    registerEntryRenderer: vi.fn(),
  })
  const sources = bindings.sources
  if (sources === undefined) throw new Error("binding missing")
  expect(bindings.host).toMatchObject({
    minimum: "1.5.0",
    testedUpTo: expect.stringMatching(/^\d+\.\d+\.\d+/) as unknown,
  })
  expect(sources.newId()).toMatch(/^[0-9a-f-]{36}$/)
  expect(sources.newId()).not.toBe(sources.newId())
  expect(sources.health.clock).toBe(Date.now)
  expect(sources.health.newId()).toMatch(/^[0-9a-f-]{36}$/)
  expect(sources.parking.clock).toBe(Date.now)
  expect(sources.capacity.clock).toBe(Date.now)
  bindings.read.mockResolvedValueOnce('{"version":1,"records":[]}')
  await sources.parking.file.read()
  expect(bindings.read).toHaveBeenLastCalledWith(
    expect.stringMatching(/[/\\]adaptive[/\\]parked\.json$/),
    "utf8",
  )
  bindings.read.mockResolvedValueOnce('{"version":1,"readings":[]}')
  await sources.capacity.file.read()
  expect(bindings.read).toHaveBeenLastCalledWith(
    expect.stringMatching(/[/\\]adaptive[/\\]capacity\.json$/),
    "utf8",
  )
  bindings.read.mockResolvedValueOnce('{"version":1,"records":[]}')
  expect(await sources.health.file.read()).toEqual({ version: 1, records: [] })
  expect(bindings.read).toHaveBeenLastCalledWith(
    expect.stringMatching(/[/\\]adaptive[/\\]health\.json$/),
    "utf8",
  )
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
