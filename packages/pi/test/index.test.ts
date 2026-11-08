import { expect, it, vi } from "vitest"
import type { SettingsV1 } from "@coool/adaptive-core/state/settings/types"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

const bindings: {
  read: ReturnType<typeof vi.fn<() => Promise<string>>>
  load: (() => Promise<SettingsV1>) | undefined
} = vi.hoisted(() => ({
  read: vi.fn<() => Promise<string>>(),
  load: undefined,
}))
vi.mock("node:fs/promises", () => ({ readFile: bindings.read }))
vi.mock("../src/host/extension.js", () => ({
  registerAdaptive: (_pi: unknown, load: () => Promise<SettingsV1>) => {
    bindings.load = load
  },
}))
import adaptive from "../src/index.js"

const pi: Pick<ExtensionAPI, "registerVirtualModel" | "getActiveTools"> = {
  registerVirtualModel: vi.fn(),
  getActiveTools: () => [],
}

it("loads defaults only for a missing file and rejects malformed settings with field feedback", async () => {
  adaptive(pi)
  const load = bindings.load
  if (load === undefined) throw new Error("binding missing")
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
