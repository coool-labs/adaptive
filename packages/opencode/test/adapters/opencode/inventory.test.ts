// covers: ["ADP-006", "ADP-017"]
import { describe, expect, it } from "vitest"
import {
  candidateFor,
  listCandidates,
  mapModelInfo,
} from "../../../src/adapters/opencode/inventory.js"
import { coreRef, fakeModel, makeInfo } from "./helpers.js"

describe("mapModelInfo", () => {
  it("maps availability, capabilities, and context limit", () => {
    const info = makeInfo("openai", "gpt-5", { enabled: false, tools: false, context: 1000 })
    const candidate = mapModelInfo(info)
    expect(candidate).toEqual({
      providerID: "openai",
      modelID: "gpt-5",
      enabled: false,
      providerEnabled: true,
      capabilities: { tools: false, input: ["text", "image"], output: ["text"] },
      limit: { context: 1000 },
    })
  })

  it("copies capability arrays (host records stay mutable internals)", () => {
    const info = makeInfo("openai", "gpt-5")
    const candidate = mapModelInfo(info)
    expect(candidate.capabilities?.input).toEqual(info.capabilities.input)
    expect(candidate.capabilities?.input).not.toBe(info.capabilities.input)
  })
})

describe("listCandidates", () => {
  it("returns all models in editor order", async () => {
    const model = fakeModel([makeInfo("p1", "a"), makeInfo("p1", "b"), makeInfo("p2", "c")])
    await expect(listCandidates(model)).resolves.toEqual([
      mapModelInfo(makeInfo("p1", "a")),
      mapModelInfo(makeInfo("p1", "b")),
      mapModelInfo(makeInfo("p2", "c")),
    ])
  })

  it("expands each offered variant into an explicit candidate", async () => {
    const model = fakeModel([makeInfo("p1", "a", { variants: ["high", "low"] })])
    const candidates = await listCandidates(model)
    expect(candidates).toHaveLength(3)
    expect(candidates[1]).toEqual({
      ...mapModelInfo(makeInfo("p1", "a")),
      variant: "high",
      variantAvailable: true,
    })
    expect(candidates[2]?.variant).toBe("low")
  })
})

describe("candidateFor", () => {
  it("resolves an exact model without variant keys", async () => {
    const model = fakeModel([makeInfo("p1", "a")])
    const found = await candidateFor(model, coreRef("p1", "a"))
    expect(found).toEqual(mapModelInfo(makeInfo("p1", "a")))
    expect("variant" in (found ?? {})).toBe(false)
  })

  it("reports variant availability for a pinned variant", async () => {
    const model = fakeModel([makeInfo("p1", "a", { variants: ["low", "high"] })])
    const found = await candidateFor(model, coreRef("p1", "a", "high"))
    expect(found).toEqual({
      ...mapModelInfo(makeInfo("p1", "a")),
      variant: "high",
      variantAvailable: true,
    })
  })

  it("returns undefined for an unknown model", async () => {
    const model = fakeModel([makeInfo("p1", "a")])
    await expect(candidateFor(model, coreRef("p1", "missing"))).resolves.toBeUndefined()
  })

  it("returns undefined when the variant does not exist", async () => {
    const model = fakeModel([makeInfo("p1", "a", { variants: ["low"] })])
    await expect(candidateFor(model, coreRef("p1", "a", "ultra"))).resolves.toBeUndefined()
  })

  it("returns disabled models (existence semantics — the gate judges availability)", async () => {
    const model = fakeModel([makeInfo("p1", "a", { enabled: false })])
    const found = await candidateFor(model, coreRef("p1", "a"))
    expect(found?.enabled).toBe(false)
  })
})
