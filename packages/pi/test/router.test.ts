import { expect, it } from "vitest"
import { defaultSettings } from "@coool/adaptive-core/state/settings/parse"
import { routeAdmission, VIRTUAL_IDS, type RouteInput } from "../src/router.js"

const a = { providerID: "faux", id: "a" }
const b = { providerID: "faux", id: "b" }
const settings = {
  ...defaultSettings(),
  mode: "active" as const,
  tiers: { quick: [a], standard: [b], advanced: [a] },
}
const input: RouteInput = {
  id: "auto",
  reason: "user",
  previous: undefined,
  settings,
  inventory: [a, b].map((ref) => ({
    providerID: ref.providerID,
    modelID: ref.id,
    enabled: true,
    providerEnabled: true,
    variantAvailable: true,
  })),
  demand: {},
}

it("registers exactly the four intended virtual IDs and defaults ambiguity to standard", () => {
  expect(VIRTUAL_IDS).toEqual(["auto", "quick", "standard", "advanced"])
  for (const id of VIRTUAL_IDS) {
    expect(routeAdmission({ ...input, id })).toMatchObject({
      kind: "apply",
      model: id === "auto" || id === "standard" ? b : a,
    })
  }
})

it("keeps continuations and native retries on their physical model", () => {
  for (const reason of ["continuation", "retry"] as const) {
    expect(routeAdmission({ ...input, reason, previous: a })).toMatchObject({
      kind: "apply",
      model: a,
      reason: "pin",
    })
    expect(routeAdmission({ ...input, reason })).toMatchObject({ kind: "apply", model: b })
  }
  expect(routeAdmission({ ...input, settings: { ...settings, pin: a } })).toMatchObject({
    model: a,
  })
})

it("uses quick for direct requests and never borrows from another tier", () => {
  expect(routeAdmission({ ...input, reason: "direct" })).toMatchObject({ model: a })
  expect(
    routeAdmission({
      ...input,
      settings: { ...settings, tiers: { ...settings.tiers, standard: [] } },
    }),
  ).toMatchObject({ kind: "park", reason: "no-candidates" })
  expect(routeAdmission({ ...input, demand: { tools: true } })).toMatchObject({
    kind: "park",
    reason: "no-compatible-resource",
  })
})
