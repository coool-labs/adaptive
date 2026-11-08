import { expect, it } from "vitest"
import { defaultSettings } from "@coool/adaptive-core/state/settings/parse"
import type { SettingsV1 } from "@coool/adaptive-core/state/settings/types"
import { escalationTool, selectedVirtual, tierTool, type ToolContext } from "../src/host/tools.js"
import type { BranchEntry } from "../src/task.js"

const active: SettingsV1 = { ...defaultSettings(), mode: "active" }
const auto = { provider: "adaptive", id: "auto" }

function context(model: ToolContext["model"], branch: readonly BranchEntry[] = []): ToolContext {
  return { model, sessionManager: { getBranch: () => branch } }
}
function taskState(tier: string, escalations: number): BranchEntry {
  return {
    type: "custom",
    customType: "pi.virtual-model-state",
    data: {
      provider: "adaptive",
      modelId: "auto",
      state: { version: 1, task: "t", unit: "u", tier, escalations },
    },
  }
}
function run(
  tool: ReturnType<typeof tierTool> | ReturnType<typeof escalationTool>,
  params: unknown,
  ctx: ToolContext,
) {
  return tool.execute("call", params, undefined, undefined, ctx)
}
const request = { reason: "too hard", evidence: "tests keep failing" }

it("recognises only Adaptive virtual entries", () => {
  expect(selectedVirtual(undefined)).toBeUndefined()
  expect(selectedVirtual({ provider: "local", id: "auto" })).toBeUndefined()
  expect(selectedVirtual({ provider: "adaptive", id: "other" })).toBeUndefined()
  expect(selectedVirtual({ provider: "adaptive", id: "quick" })).toBe("quick")
})

it("records valid tier requests only while Adaptive Auto routes", async () => {
  const tool = tierTool(() => Promise.resolve(active))
  expect(tool.name).toBe("adaptive_tier")
  expect(await run(tool, { tier: "ultra" }, context(auto))).toEqual({
    content: [
      { type: "text", text: "adaptive_tier rejected: tier must be quick, standard, or advanced." },
    ],
    details: {},
    isError: true,
  })
  expect((await run(tool, null, context(auto))).isError).toBe(true)
  expect(await run(tool, { tier: "advanced" }, context(auto))).toEqual({
    content: [
      {
        type: "text",
        text: "Tier request recorded: advanced. It applies from the next user prompt.",
      },
    ],
    details: { tier: "advanced" },
  })
  const observing = await run(
    tierTool(() => Promise.resolve(defaultSettings())),
    { tier: "quick" },
    context(auto),
  )
  expect(observing.content[0].text).toBe(
    "Tier request recorded: quick. It applies from the next user prompt. Adaptive is in observe mode, so it will not change models.",
  )
  expect(observing.details).toEqual({ tier: "quick" })
})

it("ignores tier requests when the user chose the model", async () => {
  const tool = tierTool(() => Promise.resolve(active))
  const texts = await Promise.all(
    [
      context(undefined),
      context({ provider: "local", id: "a" }),
      context({ provider: "adaptive", id: "standard" }),
    ].map(async (ctx) => (await run(tool, { tier: "advanced" }, ctx)).content[0].text),
  )
  expect(texts).toEqual([
    "Adaptive is not routing this session: the user picked a model. The tier request was not recorded.",
    "Adaptive is not routing this session: the user picked a model. The tier request was not recorded.",
    "The user pinned Adaptive standard. The tier request was not recorded.",
  ])
  const pinned = await run(
    tierTool(() => Promise.resolve({ ...active, pin: { providerID: "local", id: "a" } })),
    { tier: "advanced" },
    context(auto),
  )
  expect(pinned).toEqual({
    content: [
      { type: "text", text: "The user pinned local/a. The tier request was not recorded." },
    ],
    details: {},
  })
})

it("explains what a recorded escalation request can and cannot do", async () => {
  const tool = escalationTool(() => Promise.resolve(active))
  expect(tool.name).toBe("adaptive_escalate")
  const fresh = await run(tool, request, context(auto))
  expect(fresh).toEqual({
    content: [
      {
        type: "text",
        text: "Recorded. If this run fails on a capability gap, the task continues on advanced (0 of 2 escalations used).",
      },
    ],
    details: request,
  })
  expect((await run(tool, request, context(auto, [taskState("quick", 1)]))).content[0].text).toBe(
    "Recorded. If this run fails on a capability gap, the task continues on standard (1 of 2 escalations used).",
  )
  expect(
    (await run(tool, request, context(auto, [taskState("standard", 2)]))).content[0].text,
  ).toBe("Recorded, but this task already used its 2 escalations.")
  const ceiling = await run(tool, request, context(auto, [taskState("advanced", 1)]))
  expect(ceiling.content[0].text).toBe(
    "Recorded, but advanced is already the strongest tier; tell the user if you need a stronger model.",
  )
  expect(ceiling.details).toEqual(request)
})

it("rejects malformed escalation requests and declines without Adaptive routing", async () => {
  const tool = escalationTool(() => Promise.resolve(active))
  expect(await run(tool, { reason: "x" }, context(auto))).toEqual({
    content: [
      {
        type: "text",
        text: "adaptive_escalate rejected: reason and evidence are required non-empty strings.",
      },
    ],
    details: {},
    isError: true,
  })
  expect(
    (await run(tool, request, context({ provider: "adaptive", id: "quick" }))).content[0].text,
  ).toBe(
    "The user pinned Adaptive quick. Adaptive will not escalate; tell the user if you need a stronger model.",
  )
  const observing = await run(
    escalationTool(() => Promise.resolve(defaultSettings())),
    request,
    context(auto),
  )
  expect(observing).toEqual({
    content: [
      {
        type: "text",
        text: "Adaptive is in observe mode and will not escalate; tell the user if you need a stronger model.",
      },
    ],
    details: {},
  })
})
