/**
 * Malformed persisted state (ADP-031/ADP-036): every state key is untrusted
 * input. Whatever the host hands back — garbage, a future version, a failing
 * read — the supervisor loads, serves its control surfaces, and keeps
 * supervising instead of wedging behind a rejected load.
 */
// covers: ["ADP-029", "ADP-031", "ADP-036"]
import { describe, expect, it, vi } from "vitest"

import type { StorageSource } from "../../src/adapters/opencode/storage.js"
import { wireRef } from "../adapters/opencode/helpers.js"
import { CAPACITY_KEY } from "@coool/adaptive-core/state/capacity/types"
import { HEALTH_KEY } from "@coool/adaptive-core/state/health/types"
import { PARKED_KEY } from "@coool/adaptive-core/state/parked-work/types"
import { RECEIPTS_KEY } from "@coool/adaptive-core/state/receipts/types"
import { SESSION_MODES_KEY } from "@coool/adaptive-core/state/session-modes/types"
import { SETTINGS_KEY } from "@coool/adaptive-core/state/settings/types"
import { TIER_REQUESTS_KEY } from "@coool/adaptive-core/state/tier-requests/types"
import {
  FakeSupervisorSession,
  KeyFailStorage,
  makeSupervisor,
  seed,
  settingsJSON,
} from "./helpers.js"

const KEYS = [
  SETTINGS_KEY,
  RECEIPTS_KEY,
  PARKED_KEY,
  HEALTH_KEY,
  CAPACITY_KEY,
  SESSION_MODES_KEY,
  TIER_REQUESTS_KEY,
]

const GARBAGE: readonly unknown[] = [
  "garbage",
  42,
  [],
  null,
  { version: 999 },
  { version: 1, receipts: "no", records: "no", parked: "no", sessions: "no", readings: "no" },
]

class RejectingReads {
  readonly data = new Map<string, unknown>()
  readonly source: StorageSource
  constructor(readonly failing: string) {
    this.source = {
      get: (key: string) =>
        key === this.failing
          ? Promise.reject(new Error("read failed"))
          : Promise.resolve(this.data.get(key)),
      set: (key: string, value: unknown) => {
        this.data.set(key, value)
        return Promise.resolve()
      },
    } as unknown as StorageSource
  }
}

async function exercise(storage: { source: StorageSource; data: Map<string, unknown> }) {
  const session = new FakeSupervisorSession()
  const supervisor = makeSupervisor({
    storage: storage as unknown as KeyFailStorage,
    session,
  })
  await expect(supervisor.settings()).resolves.toMatchObject({ version: 1 })
  await expect(supervisor.status()).resolves.toHaveProperty("mode")
  await expect(supervisor.receipts()).resolves.toBeInstanceOf(Array)
  await expect(supervisor.getSessionMode("s1")).resolves.toBeNull()
  await expect(supervisor.getTierRequest("s1")).resolves.toBeNull()
  await supervisor.handleReport({ kind: "execution-started", sessionID: "s1", at: 1 })
  await supervisor.handleReport({ kind: "idle", sessionID: "s1" })
  return { supervisor, session }
}

describe("malformed persisted state", () => {
  for (const key of KEYS) {
    it.each(GARBAGE.map((value) => [JSON.stringify(value), value] as const))(
      `%s under ${key} never wedges the supervisor`,
      async (_label, value) => {
        const errors = vi.spyOn(console, "error").mockImplementation(() => undefined)
        const storage = new KeyFailStorage("unused")
        seed(storage, key, value)
        await exercise(storage)
        errors.mockRestore()
      },
    )

    it(`a failing read of ${key} never wedges the supervisor`, async () => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => undefined)
      await exercise(new RejectingReads(key))
      errors.mockRestore()
    })
  }

  it("migrates a legacy control mode to active on read (ADP-029)", async () => {
    const storage = new KeyFailStorage("unused")
    seed(storage, SETTINGS_KEY, {
      ...settingsJSON("active", { standard: [wireRef("prov", "a")] }),
      mode: "control",
    })
    const { supervisor, session } = await exercise(storage)
    expect((await supervisor.settings()).mode).toBe("active")
    expect(session.log).toEqual(["switch:s1:prov/a"])
  })
})
