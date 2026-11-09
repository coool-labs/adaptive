import { expect, it } from "vitest"
import { schedulerHealthKey } from "@coool/adaptive-core/routing/scheduler/types"
import { defaultSettings } from "@coool/adaptive-core/state/settings/parse"
import { admissionCandidates, routeAdmission, VIRTUAL_IDS, type RouteInput } from "../src/router.js"

const a = { providerID: "faux", id: "a" }
const b = { providerID: "faux", id: "b" }
const settings = {
  ...defaultSettings(),
  mode: "active" as const,
  tiers: { quick: [a], standard: [b], advanced: [a] },
}
const input: RouteInput = {
  tier: "standard",
  sticky: false,
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
  health: {},
  exclude: [],
}

it("registers exactly the four intended virtual IDs and admits within the planned tier", () => {
  expect(VIRTUAL_IDS).toEqual(["auto", "quick", "standard", "advanced"])
  for (const tier of ["quick", "standard", "advanced"] as const) {
    expect(routeAdmission({ ...input, tier })).toMatchObject({
      kind: "apply",
      model: tier === "standard" ? b : a,
    })
  }
})

it("keeps in-unit requests on their physical model and honours the user pin otherwise", () => {
  expect(routeAdmission({ ...input, sticky: true, previous: a })).toMatchObject({
    kind: "apply",
    model: a,
    reason: "pin",
  })
  expect(routeAdmission({ ...input, sticky: true })).toMatchObject({ kind: "apply", model: b })
  expect(routeAdmission({ ...input, previous: a })).toMatchObject({ model: b })
  expect(routeAdmission({ ...input, settings: { ...settings, pin: a } })).toMatchObject({
    model: a,
  })
})

it("never borrows from another tier and gates compatibility", () => {
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

it("avoids models the unit already failed on, falling back to them when nothing else fits", () => {
  const tiers = { ...settings.tiers, standard: [b, a] }
  const recovering = { ...input, settings: { ...settings, tiers } }
  expect(routeAdmission({ ...recovering, exclude: [b] })).toMatchObject({ kind: "apply", model: a })
  expect(routeAdmission({ ...input, exclude: [b] })).toMatchObject({ kind: "apply", model: b })
  // Health still blocks the fallback: an excluded, limited model is not retried.
  expect(
    routeAdmission({
      ...input,
      exclude: [b],
      health: {
        [schedulerHealthKey(b)]: {
          kind: "blocked",
          reason: "rate-limited",
          key: { providerID: "faux", modelID: "b" },
        },
      },
    }),
  ).toMatchObject({ kind: "park" })
})

it("lists the tier's models for admission, or only the user pin", () => {
  expect(admissionCandidates(settings, "standard")).toEqual([b])
  expect(admissionCandidates({ ...settings, pin: a }, "standard")).toEqual([a])
})
