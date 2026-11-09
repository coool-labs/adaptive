// covers: ["ADP-029", "ADP-032", "ADP-051", "ADP-059", "ADP-063"]
import { expect, it } from "vitest"
import { defaultSettings } from "@coool/adaptive-core/state/settings/parse"
import { parseSettings, readSettings, updateSettings } from "../src/settings.js"
import { parsePreferences, readPreferences, updatePreferences } from "../src/preferences.js"
import { memoryFile } from "./support/memory-file.js"

it("defaults to observe without writing, and migrates legacy control", async () => {
  const file = memoryFile()
  expect(await readSettings(file)).toEqual(defaultSettings())
  expect(file.value()).toBeUndefined()
  expect(parseSettings({ mode: "control" }).mode).toBe("active")
  expect(parseSettings({ version: 0 }).mode).toBe("observe")
})

it("patches the latest locked snapshot rather than a cached settings object", async () => {
  const file = memoryFile()
  await Promise.all([
    updateSettings(file, { inviteDismissed: true }),
    updateSettings(file, { mode: "off" }),
  ])
  expect(await readSettings(file)).toMatchObject({ mode: "off", inviteDismissed: true })
  const before = file.value()
  expect(await updateSettings(file, { mode: "wrong" })).toEqual({
    ok: false,
    errors: ["invalid mode"],
  })
  expect(file.value()).toBe(before)
})

it("rejects corrupt, unknown-version and malformed settings without rewriting", async () => {
  for (const raw of [
    null,
    [],
    1,
    { version: 2 },
    { extra: true },
    { mode: "bad" },
    { inviteDismissed: "true" },
    { pin: {} },
    { tiers: {} },
    { tiers: { quick: [], standard: [], advanced: [null] } },
    { tiers: { quick: [], standard: [], advanced: [{ providerID: "p", id: "a", variant: 1 }] } },
    { agentTiers: { x: "bad" } },
    { tiers: null },
    { tiers: { other: [] } },
  ]) {
    const file = memoryFile(raw)
    await expect(updateSettings(file, { inviteDismissed: true })).rejects.toThrow(
      "Adaptive settings",
    )
    expect(file.value()).toBe(raw)
  }
  expect(parseSettings({ pin: null, agentTiers: { worker: "quick" } }).agentTiers).toEqual({
    worker: "quick",
  })
  expect(await updateSettings(memoryFile(), { extra: true })).toMatchObject({ ok: false })
  expect(await updateSettings(memoryFile(), null)).toEqual({ ok: false, errors: ["invalid patch"] })
})

it("strictly validates resource identifiers, list bounds and agent hints", () => {
  const ref = { providerID: "p", id: "m", variant: "high" }
  expect(
    parseSettings({ tiers: { quick: [ref], standard: [], advanced: [] } }).tiers.quick,
  ).toEqual([ref])
  for (const ref of [
    { providerID: "", id: "m" },
    { providerID: "p", id: " " },
    { providerID: "p", id: "m", secret: "x" },
    { providerID: "p", id: "m", variant: "" },
  ])
    expect(() => parseSettings({ pin: ref })).toThrow("pin")
  expect(() => parseSettings({ agentTiers: { "": "quick" } })).toThrow("agentTiers")
  expect(() => parseSettings({ agentTiers: null })).toThrow("agentTiers")
  expect(() =>
    parseSettings({
      tiers: { quick: Array.from({ length: 33 }, () => ref), standard: [], advanced: [] },
    }),
  ).toThrow("quick")
  expect(() => parseSettings({ tiers: { quick: [ref, ref], standard: [], advanced: [] } })).toThrow(
    "quick",
  )
  expect(() =>
    parseSettings({
      tiers: {
        quick: [ref, { variant: "high", id: "m", providerID: "p" }],
        standard: [],
        advanced: [],
      },
    }),
  ).toThrow("quick")
})

it("keeps Pi-only preferences separate and patches without lost updates", async () => {
  const file = memoryFile()
  expect(await readPreferences(file)).toEqual({
    version: 1,
    verbosity: "changes",
    escalateFromPinned: false,
  })
  expect(file.value()).toBeUndefined()
  await Promise.all([
    updatePreferences(file, { verbosity: "quiet" }),
    updatePreferences(file, { escalateFromPinned: true }),
  ])
  expect(await readPreferences(file)).toEqual({
    version: 1,
    verbosity: "quiet",
    escalateFromPinned: true,
  })
  await updatePreferences(file, { verbosity: "all" })
  const before = file.value()
  for (const patch of [null, { verbosity: "bad" }, { escalateFromPinned: 1 }, { secret: true }])
    await expect(updatePreferences(file, patch)).rejects.toThrow("Adaptive preferences")
  expect(file.value()).toBe(before)
  for (const raw of [
    null,
    [],
    { version: 2 },
    { verbosity: 1 },
    { escalateFromPinned: "yes" },
    { version: 1, extra: true },
  ])
    expect(() => parsePreferences(raw)).toThrow("Adaptive preferences")
})
