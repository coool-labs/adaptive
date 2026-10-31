/**
 * Settings module tests (ADP-029/032/036/005): bounded shape validation,
 * migration-on-read, patch application, and the store over a narrow storage
 * seam. The read path is total — arbitrary garbage must degrade to defaults,
 * never throw (ADP-031 discipline for state).
 */
import fc from "fast-check"
import { afterEach, describe, expect, test, vi } from "vitest"
import {
  MAX_AGENT_TIERS,
  MAX_TIER_RESOURCES,
  SETTINGS_KEY,
  SETTINGS_VERSION,
  SettingsStore,
  applyPatch,
  defaultSettings,
  migrateSettings,
  parseAgentTiers,
  parseMode,
  parsePin,
  parseTierLists,
} from "../../../src/state/settings/index.js"
import type {
  SettingsPatch,
  SettingsStorage,
  SettingsV1,
} from "../../../src/state/settings/index.js"
import { OPERATING_MODES } from "../../../src/core/scheduler/types.js"
import { TIERS } from "../../../src/core/tier-policy/types.js"

function ref(providerID: string, id: string, variant?: string) {
  return variant === undefined ? { providerID, id } : { providerID, id, variant }
}

const STORED: SettingsV1 = {
  version: 1,
  mode: "control",
  tiers: { quick: [ref("p", "m")], standard: [], advanced: [] },
  pin: ref("p", "m", "high"),
  agentTiers: { build: "advanced" },
  inviteDismissed: true,
}

class FakeStorage implements SettingsStorage {
  #raw: unknown = undefined
  #failRead = false
  #failWrite = false
  writes = 0

  read(): Promise<unknown> {
    if (this.#failRead) return Promise.reject(new Error("storage read failed"))
    return Promise.resolve(this.#raw)
  }

  write(settings: SettingsV1): Promise<void> {
    this.writes += 1
    if (this.#failWrite) return Promise.reject(new Error("storage write failed"))
    this.#raw = settings
    return Promise.resolve()
  }

  seed(raw: unknown): void {
    this.#raw = raw
  }

  failRead(): void {
    this.#failRead = true
  }

  failWrite(): void {
    this.#failWrite = true
  }
}

describe("runtime constants", () => {
  test("settings key is namespaced under the plugin", () => {
    expect(SETTINGS_KEY).toBe("coool.adaptive/settings")
  })

  test("current schema version is 1", () => {
    expect(SETTINGS_VERSION).toBe(1)
  })

  test("product bounds are pinned", () => {
    expect(MAX_TIER_RESOURCES).toBe(32)
    expect(MAX_AGENT_TIERS).toBe(64)
  })
})

describe("defaultSettings", () => {
  test("first install: observe mode, empty configuration (ADP-029/032)", () => {
    expect(defaultSettings()).toEqual({
      version: 1,
      mode: "observe",
      tiers: { quick: [], standard: [], advanced: [] },
      pin: null,
      agentTiers: {},
      inviteDismissed: false,
    })
  })
})

describe("parseMode", () => {
  test("accepts each operating mode", () => {
    for (const mode of OPERATING_MODES) expect(parseMode(mode)).toBe(mode)
  })

  test("rejects unknown strings and non-strings", () => {
    expect(parseMode("auto")).toBeUndefined()
    expect(parseMode(1)).toBeUndefined()
    expect(parseMode(null)).toBeUndefined()
  })
})

describe("parseTierLists", () => {
  test("normalizes each tier: drops invalid, dedupes, keeps order", () => {
    const parsed = parseTierLists({
      quick: [ref("p", "a"), ref("p", "a"), ref("", "x"), null, ref("p", "b")],
      standard: [ref("p", "c", "high")],
      advanced: [],
    })
    expect(parsed).toEqual({
      quick: [ref("p", "a"), ref("p", "b")],
      standard: [ref("p", "c", "high")],
      advanced: [],
    })
  })

  test("missing and non-array tiers become empty lists; unknown keys are dropped", () => {
    const parsed = parseTierLists({ standard: "nope", bogus: [ref("p", "x")] })
    expect(parsed).toEqual({ quick: [], standard: [], advanced: [] })
  })

  test("caps each list at MAX_TIER_RESOURCES", () => {
    const many = Array.from({ length: 40 }, (_, i) => ref("p", String(i)))
    const parsed = parseTierLists({ quick: many })
    expect(parsed?.quick).toHaveLength(MAX_TIER_RESOURCES)
    expect(parsed?.quick[0]).toEqual(ref("p", "0"))
  })

  test("non-object input is rejected", () => {
    expect(parseTierLists(undefined)).toBeUndefined()
    expect(parseTierLists([])).toBeUndefined()
  })

  test("garbage elements never throw (null element regression)", () => {
    const parsed = parseTierLists({ quick: [null, 3, "x", {}, { providerID: "p" }] })
    expect(parsed?.quick).toEqual([])
  })
})

describe("parsePin", () => {
  test("null explicitly clears the pin", () => {
    expect(parsePin(null)).toBeNull()
  })

  test("valid ref with and without variant", () => {
    expect(parsePin(ref("p", "m", "high"))).toEqual(ref("p", "m", "high"))
    expect(parsePin({ providerID: "p", id: "m", extra: true })).toEqual(ref("p", "m"))
  })

  test("rejects missing/empty fields and non-objects", () => {
    expect(parsePin({ providerID: "p" })).toBeUndefined()
    expect(parsePin({ id: "m" })).toBeUndefined()
    expect(parsePin({ providerID: "", id: "m" })).toBeUndefined()
    expect(parsePin({ providerID: "p", id: "" })).toBeUndefined()
    expect(parsePin(42)).toBeUndefined()
    expect(parsePin(undefined)).toBeUndefined()
  })

  test("empty variant string is dropped, not kept", () => {
    expect(parsePin({ providerID: "p", id: "m", variant: "" })).toEqual(ref("p", "m"))
  })
})

describe("parseAgentTiers", () => {
  test("keeps valid entries and drops invalid ones", () => {
    const parsed = parseAgentTiers({
      build: "advanced",
      plan: "quick",
      x: "nope",
      "": "quick",
      y: 3,
    })
    expect(parsed).toEqual({ build: "advanced", plan: "quick" })
  })

  test("non-object input is rejected", () => {
    expect(parseAgentTiers("nope")).toBeUndefined()
    expect(parseAgentTiers(null)).toBeUndefined()
  })

  test("caps entries at MAX_AGENT_TIERS", () => {
    const raw: Record<string, unknown> = {}
    for (let i = 0; i < 70; i += 1) raw[String(i)] = "quick"
    const parsed = parseAgentTiers(raw)
    expect(Object.keys(parsed ?? {})).toHaveLength(MAX_AGENT_TIERS)
  })

  test("a __proto__ key from parsed JSON stays an own property", () => {
    const raw = JSON.parse('{"__proto__":"quick","build":"advanced"}') as Record<string, unknown>
    const parsed = parseAgentTiers(raw)
    expect(Object.hasOwn(parsed ?? {}, "__proto__")).toBe(true)
    expect(Object.getPrototypeOf(parsed ?? {})).toBe(Object.prototype)
    expect(parsed?.["build"]).toBe("advanced")
  })
})

describe("migrateSettings", () => {
  test("empty/absent record → first-install defaults", () => {
    expect(migrateSettings(undefined)).toEqual(defaultSettings())
    expect(migrateSettings(null)).toEqual(defaultSettings())
    expect(migrateSettings(42)).toEqual(defaultSettings())
    expect(migrateSettings("junk")).toEqual(defaultSettings())
  })

  test("v0 (versionless draft with recognized fields) migrates and stamps v1", () => {
    const migrated = migrateSettings({
      mode: "control",
      tiers: { standard: [ref("p", "m")] },
      pin: { providerID: "p", id: "m" },
      agentTiers: { build: "quick" },
      inviteDismissed: true,
    })
    expect(migrated).toEqual({
      version: 1,
      mode: "control",
      tiers: { quick: [], standard: [ref("p", "m")], advanced: [] },
      pin: ref("p", "m"),
      agentTiers: { build: "quick" },
      inviteDismissed: true,
    })
  })

  test("version 0 migrates like a versionless draft", () => {
    expect(migrateSettings({ version: 0, mode: "off" }).mode).toBe("off")
  })

  test("v1 record validates field-wise", () => {
    expect(migrateSettings(STORED)).toEqual(STORED)
  })

  test("v1 record with unusable fields falls back per field", () => {
    const migrated = migrateSettings({
      version: 1,
      mode: "auto",
      tiers: "nope",
      pin: 7,
      agentTiers: [],
      inviteDismissed: "yes",
    })
    expect(migrated).toEqual(defaultSettings())
  })

  test("a record from a newer version is not guessed at: defaults", () => {
    expect(migrateSettings({ version: 2, mode: "control" })).toEqual(defaultSettings())
    expect(migrateSettings({ version: "1", mode: "control" })).toEqual(defaultSettings())
  })
})

describe("applyPatch", () => {
  test("a non-object patch is rejected, not trusted by its type", () => {
    expect(applyPatch(defaultSettings(), null)).toEqual({
      ok: false,
      errors: ["invalid patch"],
    })
    expect(applyPatch(defaultSettings(), 3)).toEqual({
      ok: false,
      errors: ["invalid patch"],
    })
  })

  test("empty patch returns equal settings", () => {
    const result = applyPatch(STORED, {})
    expect(result).toEqual({ ok: true, settings: STORED })
  })

  test.each(["off", "observe", "control"] as const)("updates mode to %s", (mode) => {
    const result = applyPatch(defaultSettings(), { mode })
    expect(result).toEqual({ ok: true, settings: { ...defaultSettings(), mode } })
  })

  test("updates tier lists, normalized and capped", () => {
    const result = applyPatch(defaultSettings(), {
      tiers: { quick: [ref("p", "a"), ref("p", "a")], standard: [], advanced: [] },
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.settings.tiers.quick).toEqual([ref("p", "a")])
  })

  test("sets the pin; pin null clears it; pin undefined leaves it", () => {
    const set = applyPatch(defaultSettings(), { pin: ref("p", "m", "high") })
    expect(set.ok && set.settings.pin).toEqual(ref("p", "m", "high"))
    const cleared = applyPatch({ ...STORED }, { pin: null })
    expect(cleared.ok && cleared.settings.pin).toBeNull()
    const untouched = applyPatch(STORED, {})
    expect(untouched.ok && untouched.settings.pin).toEqual(STORED.pin)
  })

  test("updates agentTiers and inviteDismissed", () => {
    const result = applyPatch(defaultSettings(), {
      agentTiers: { build: "advanced" },
      inviteDismissed: true,
    })
    expect(result.ok && result.settings.agentTiers).toEqual({ build: "advanced" })
    expect(result.ok && result.settings.inviteDismissed).toBe(true)
  })

  test("invalid fields collect bounded errors in field order", () => {
    const bad = {
      mode: "auto",
      tiers: "nope",
      pin: "nope",
      agentTiers: [],
      inviteDismissed: "yes",
    } as unknown as SettingsPatch
    const result = applyPatch(defaultSettings(), bad)
    expect(result).toEqual({
      ok: false,
      errors: [
        "invalid mode",
        "invalid tiers",
        "invalid pin",
        "invalid agentTiers",
        "invalid inviteDismissed",
      ],
    })
  })

  test("valid fields alongside invalid ones yield per-field errors, bounded by field count", () => {
    const patch = {
      mode: "control",
      tiers: 3,
      pin: "nope",
      agentTiers: [],
      inviteDismissed: "yes",
    } as unknown as SettingsPatch
    const result = applyPatch(defaultSettings(), patch)
    expect(result).toEqual({
      ok: false,
      errors: ["invalid tiers", "invalid pin", "invalid agentTiers", "invalid inviteDismissed"],
    })
  })

  test("never mutates the current settings", () => {
    const snapshot = structuredClone(STORED)
    applyPatch(STORED, { mode: "off", pin: ref("q", "n") })
    expect(STORED).toEqual(snapshot)
  })
})

describe("SettingsStore", () => {
  test("loads and migrates the persisted record", async () => {
    const storage = new FakeStorage()
    storage.seed({ version: 1, mode: "control", tiers: { standard: [ref("p", "m")] } })
    const store = new SettingsStore(storage)
    const loaded = await store.load()
    expect(loaded.mode).toBe("control")
    expect(loaded.tiers.standard).toEqual([ref("p", "m")])
    expect(store.get()).toBe(loaded)
  })

  test("first install: absent record loads defaults", async () => {
    const store = new SettingsStore(new FakeStorage())
    expect(await store.load()).toEqual(defaultSettings())
  })

  test("read failure fails open to defaults (ADP-031)", async () => {
    const storage = new FakeStorage()
    storage.seed(STORED)
    storage.failRead()
    const store = new SettingsStore(storage)
    expect(await store.load()).toEqual(defaultSettings())
  })

  test("snapshot defaults before load", () => {
    expect(new SettingsStore(new FakeStorage()).get()).toEqual(defaultSettings())
  })

  test("update validates, persists, then adopts", async () => {
    const storage = new FakeStorage()
    const store = new SettingsStore(storage)
    await store.load()
    const result = await store.update({ mode: "control" })
    expect(result.ok).toBe(true)
    expect(store.get().mode).toBe("control")
    expect(storage.writes).toBe(1)
    const stored = await storage.read()
    expect(stored).toEqual(store.get())
  })

  test("invalid patch changes nothing and writes nothing", async () => {
    const storage = new FakeStorage()
    const store = new SettingsStore(storage)
    await store.load()
    const result = await store.update({ mode: "auto" as unknown as "off" })
    expect(result.ok).toBe(false)
    expect(store.get().mode).toBe("observe")
    expect(storage.writes).toBe(0)
  })

  test("write failure propagates and the snapshot stays unchanged", async () => {
    const storage = new FakeStorage()
    const store = new SettingsStore(storage)
    await store.load()
    storage.failWrite()
    await expect(store.update({ mode: "control" })).rejects.toThrow("storage write failed")
    expect(store.get().mode).toBe("observe")
  })
})

describe("settings properties", () => {
  const jsonArb = fc.jsonValue()

  test("migrateSettings is total and deterministic over arbitrary input", () => {
    fc.assert(
      fc.property(jsonArb, (raw) => {
        const first = migrateSettings(raw)
        const second = migrateSettings(raw)
        expect(first).toEqual(second)
        expect(first.version).toBe(1)
        expect(OPERATING_MODES).toContain(first.mode)
        expect(first.pin === null || typeof first.pin === "object").toBe(true)
      }),
      { numRuns: 300 },
    )
  })

  test("parseTierLists yields duplicate-free lists that are subsequences of input order", () => {
    const refArb = fc.record({
      providerID: fc.string({ minLength: 1 }),
      id: fc.string({ minLength: 1 }),
      variant: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
    })
    const listArb = fc.array(fc.oneof(refArb, fc.constant(null), fc.integer()))
    const identity = (r: { providerID: string; id: string; variant?: string | undefined }) =>
      `${r.providerID}|${r.id}|${r.variant ?? ""}`
    const rawVariant = (raw: object) => {
      const v = (raw as Record<string, unknown>)["variant"]
      return typeof v === "string" && v !== "" ? v : undefined
    }
    const rawMatches = (
      raw: unknown,
      item: { providerID: string; id: string; variant?: string | undefined },
    ) =>
      typeof raw === "object" &&
      raw !== null &&
      (raw as Record<string, unknown>)["providerID"] === item.providerID &&
      (raw as Record<string, unknown>)["id"] === item.id &&
      rawVariant(raw) === item.variant
    fc.assert(
      fc.property(listArb, (list) => {
        const parsed = parseTierLists({ quick: list })
        const quick = parsed?.quick ?? []
        const seen: string[] = []
        let cursor = 0
        for (const item of quick) {
          const id = identity(item)
          expect(seen).not.toContain(id)
          seen.push(id)
          while (cursor < list.length && !rawMatches(list[cursor], item)) cursor += 1
          // Kept refs appear in the same relative order as the raw list.
          expect(cursor < list.length).toBe(true)
          cursor += 1
        }
        expect(quick.length).toBeLessThanOrEqual(MAX_TIER_RESOURCES)
      }),
      { numRuns: 200 },
    )
  })

  test("applyPatch is total over arbitrary patches and invariants hold", () => {
    fc.assert(
      fc.property(jsonArb, (raw) => {
        const result = applyPatch(defaultSettings(), raw)
        if (result.ok) {
          expect(OPERATING_MODES).toContain(result.settings.mode)
          expect(Object.keys(result.settings.tiers).sort()).toEqual([...TIERS].sort())
          expect(typeof result.settings.inviteDismissed).toBe("boolean")
        } else {
          expect(result.errors.length).toBeGreaterThan(0)
          expect(result.errors.length).toBeLessThanOrEqual(5)
        }
      }),
      { numRuns: 300 },
    )
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})
