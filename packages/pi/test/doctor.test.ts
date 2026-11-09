// covers: ["ADP-062"]
import { expect, it } from "vitest"
import { fauxProvider } from "@earendil-works/pi-ai"
import { defaultSettings } from "@coool/adaptive-core/state/settings/parse"
import { versionChecks, doctorLines } from "../src/ui/doctor.js"
import { doctorChecks, type DoctorOptions } from "../src/host/doctor.js"

it("distinguishes supported range from actual matrix evidence without fabricating tested-up-to", () => {
  expect(versionChecks("1.5.0", "1.5.0", "1.5.0").every((check) => check.state === "ok")).toBe(true)
  expect(doctorLines(versionChecks("1.6.0", "1.5.0", "1.5.0")).join("\n")).toContain(
    "newer than last tested",
  )
  expect(versionChecks("1.5.1", "1.5.0", "1.5.0").at(-1)?.state).toBe("warning")
  expect(versionChecks("1.5.0", "1.5.0", undefined).at(-1)?.message).toContain("not recorded")
  expect(versionChecks("1.5.0", "1.5.0", "bad").at(-1)?.state).toBe("warning")
  for (const version of ["1.4.0", "2.0.0", "0.9.0"])
    expect(versionChecks(version, "1.5.0", "1.5.0")[0]?.state).toBe("error")
  expect(versionChecks("1.5.0-rc", "1.5.0", undefined)[0]?.state).toBe("warning")
  expect(versionChecks("1.5.0", "bad", undefined)[0]?.state).toBe("warning")
  expect(doctorLines([{ state: "error", message: "bad", action: "fix" }])).toEqual([
    "ERROR bad",
    "  fix",
  ])
})

function options(): DoctorOptions {
  const provider = fauxProvider({ provider: "local", models: [{ id: "a" }, { id: "b" }] })
  const base = provider.models[0]
  const virtuals = ["auto", "quick", "standard", "advanced"].map((id) => ({
    ...base,
    id,
    provider: "adaptive",
    api: "pi-virtual",
  }))
  const models = [...provider.models, ...virtuals]
  return {
    version: "1.5.0",
    minimum: "1.5.0",
    testedUpTo: "1.5.0",
    registry: {
      getAll: () => models,
      find: (provider, id) =>
        models.find((model) => model.provider === provider && model.id === id),
      hasConfiguredAuth: (model) => model.id !== "b",
      getRegisteredProviderConfig: () => undefined,
    },
    settings: () =>
      Promise.resolve({
        ...defaultSettings(),
        tiers: {
          quick: [{ providerID: "local", id: "a" }],
          standard: [{ providerID: "local", id: "b" }],
          advanced: [{ providerID: "missing", id: "m" }],
        },
      }),
    capabilities: () => Promise.resolve([{ providerID: "local", id: "a", tools: true }]),
    storage: () => Promise.resolve(),
    health: () => Promise.resolve(1),
    parked: () => Promise.resolve(2),
  }
}

it("reports credentials, capability gaps, storage, health and parked work with remedies", async () => {
  const checks = await doctorChecks(options())
  const text = doctorLines(checks).join("\n")
  expect(text).toContain("All four Adaptive models")
  expect(text).toContain("credentials configured")
  expect(text).toContain("/login local")
  expect(text).toContain("model missing")
  expect(text).toContain("tool support is not declared")
  expect(text).toContain("exclusive lock works")
  expect(text).toContain("1 resources limited")
  expect(text).toContain("2 parked tasks")
  expect(
    checks.filter((check) => check.state !== "ok").every((check) => check.action !== undefined),
  ).toBe(true)
})

it("checks empty tiers, no parked work, registration and potential router conflicts without exposing configs", async () => {
  const base = options()
  const models = base.registry.getAll()
  const first = models[0]
  if (first === undefined) throw new Error("faux model missing")
  const checks = await doctorChecks({
    ...base,
    settings: () => Promise.resolve(defaultSettings()),
    health: () => Promise.resolve(0),
    parked: () => Promise.resolve(0),
    registry: {
      ...base.registry,
      find: () => undefined,
      getAll: () => [...models, { ...first, provider: "other", api: "pi-virtual" }],
      getRegisteredProviderConfig: () => ({
        apiKey: "SECRET",
        streamSimple: () => {
          throw new Error("not invoked")
        },
      }),
    },
  })
  const text = doctorLines(checks).join("\n")
  expect(text).toContain("Missing Adaptive models")
  expect(text).toContain("no configured models")
  expect(text).toContain("Other router model")
  expect(text).toContain("Custom request handler")
  expect(text).toContain("No parked work")
  expect(text).not.toContain("SECRET")
})

it("uses fixed secret-free error copy for every optional probe failure", async () => {
  const fail = () => Promise.reject(new Error("SECRET"))
  const base = options()
  const text = doctorLines(
    await doctorChecks({ ...base, settings: fail, storage: fail, health: fail, parked: fail }),
  ).join("\n")
  expect(text).not.toContain("SECRET")
  expect(text).toContain("Settings or capabilities could not be read")
  expect(text).toContain("lock unavailable")
  expect(text).toContain("Shared health could not be read")
  expect(text).toContain("Parked work could not be read")
  expect(doctorLines(await doctorChecks({ ...base, capabilities: fail })).join("\n")).not.toContain(
    "SECRET",
  )
})
