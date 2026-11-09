import { vi } from "vitest"
import type { ModelRouteRequest } from "@earendil-works/pi-coding-agent"
import { fauxProvider } from "@earendil-works/pi-ai"
import { defaultSettings } from "@coool/adaptive-core/state/settings/parse"
import type { SettingsV1 } from "@coool/adaptive-core/state/settings/types"
import { registerAdaptive, type AdaptiveSources } from "../src/host/extension.js"
import { observeInput } from "../src/host/observe.js"
import type { RouteContext } from "../src/host/routing.js"
import { memoryFile } from "./memory-file.js"

export function routingFixture(settings: SettingsV1 = defaultSettings()) {
  const faux = fauxProvider({
    provider: "local",
    models: [
      { id: "a", reasoning: true },
      { id: "b", reasoning: true },
    ],
  })
  const [a] = faux.models
  let next = 0
  const newId = () => `unit-${String(++next)}`
  const sources: AdaptiveSources = {
    settings: () => Promise.resolve(settings),
    capabilities: vi.fn<AdaptiveSources["capabilities"]>(() => Promise.resolve([])),
    newId,
    health: { file: memoryFile(), clock: () => 1_000, newId },
    capacity: { file: memoryFile(), clock: () => 1_000 },
    parking: { file: memoryFile(), clock: () => 1_000, timer: () => () => undefined },
    receipts: memoryFile(),
    preferences: memoryFile({ version: 1, verbosity: "quiet", escalateFromPinned: false }),
  }
  const registerVirtualModel = vi.fn()
  const host = { appendEntry: vi.fn(), getActiveTools: vi.fn((): string[] => []) }
  // The host's overloaded registration surface cannot be represented by a plain fake.
  const pi = {
    ...host,
    registerVirtualModel,
    registerTool: vi.fn(),
    registerEntryRenderer: vi.fn(),
    registerCommand: vi.fn(),
    registerShortcut: vi.fn(),
    on: vi.fn(),
  } as unknown as Parameters<typeof registerAdaptive>[0]
  registerAdaptive(pi, sources, {
    settings: memoryFile(),
    capabilities: memoryFile(),
    version: "1.5.0",
    minimum: "1.5.0",
    testedUpTo: "1.5.0",
  })
  const route = (id = "auto") => {
    const definition = registerVirtualModel.mock.calls
      .map(
        ([entry]) =>
          entry as {
            id: string
            route: (
              request: ModelRouteRequest,
              ctx: RouteContext,
            ) => Promise<{
              model: typeof a
              thinkingLevel: string
              state?: unknown
            }>
          },
      )
      .find((entry) => entry.id === id)
    if (definition === undefined) throw new Error("missing registered route")
    return definition.route
  }
  return {
    sources,
    faux,
    a,
    host,
    route,
    observe: observeInput(host, sources, { last: undefined }),
  }
}
