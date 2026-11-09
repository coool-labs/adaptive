// covers: ["ADP-006", "ADP-017", "ADP-057", "ADP-063"]
import { expect, it } from "vitest"
import { fauxProvider } from "@earendil-works/pi-ai"
import {
  availablePhysicalModels,
  modelInventory,
  modelSummaries,
  proposalModels,
  requestDemand,
  thinkingLevelFor,
} from "../src/host/inventory.js"

it("uses available physical models only and preserves explicit tool/thinking capabilities", () => {
  const faux = fauxProvider({
    provider: "local",
    models: [{ id: "a", reasoning: true }, { id: "b" }, { id: "c" }],
  })
  const model = faux.models[0]
  const models = availablePhysicalModels({
    getAvailable: () => [
      ...faux.models,
      { ...model, provider: "adaptive" },
      { ...model, provider: "other-router", api: "pi-virtual" },
    ],
  })
  expect(models).toEqual(faux.models)
  const inventory = modelInventory(models, [
    { providerID: "other", id: "a", tools: true },
    { providerID: "local", id: "b", tools: false },
    { providerID: "local", id: "a", tools: true },
  ])
  expect(
    inventory.find((entry) => entry.modelID === "a" && entry.variant === "high"),
  ).toMatchObject({ variantAvailable: true, capabilities: { tools: true } })
  expect(inventory.find((entry) => entry.modelID === "b")).toMatchObject({
    capabilities: { tools: false },
  })
  expect(inventory.find((entry) => entry.modelID === "c")?.capabilities?.tools).toBeUndefined()
  expect(modelSummaries(models)[0]?.variants).toContain("high")
  expect(proposalModels(models)[0]).toMatchObject({
    reasoning: true,
    ref: { providerID: "local", id: "a" },
  })
  expect(thinkingLevelFor(model, { providerID: "local", id: "a", variant: "high" }, "off")).toBe(
    "high",
  )
  expect(thinkingLevelFor(model, { providerID: "local", id: "a" }, "off")).toBe("off")
  expect(() =>
    thinkingLevelFor(model, { providerID: "local", id: "a", variant: "imaginary" }, "off"),
  ).toThrow("variant")
})

it("derives demand from the same normalized request messages for observe and dispatch", () => {
  expect(requestDemand([], [])).toMatchObject({ tools: false, input: ["text"] })
  expect(requestDemand([{ role: "user", content: "hello", timestamp: 0 }], ["read"])).toMatchObject(
    { tools: true, input: ["text"] },
  )
  const demand = requestDemand(
    [
      {
        role: "user",
        timestamp: 0,
        content: [
          { type: "text", text: "hello" },
          { type: "image", data: "AA==", mimeType: "image/png" },
        ],
      },
    ],
    ["read"],
  )
  expect(demand.input).toEqual(["text", "image"])
  expect(demand.contextTokens).toBeGreaterThan(0)
  expect(
    requestDemand(
      [
        {
          role: "assistant",
          content: [],
          api: "faux",
          provider: "local",
          model: "a",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 0,
        },
      ],
      [],
    ),
  ).toMatchObject({ input: ["text"] })
})
