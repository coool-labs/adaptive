// covers: ["ADP-018", "ADP-019", "ADP-024", "ADP-029"]
import { describe, expect, it, vi } from "vitest"
import { PARKED_KEY } from "@coool/adaptive-core/state/parked-work/types"
import { SETTINGS_KEY } from "@coool/adaptive-core/state/settings/types"
import { wireRef } from "../adapters/opencode/helpers.js"
import {
  FakeSupervisorSession,
  KeyFailStorage,
  makeSupervisor,
  ref,
  seed,
  settingsJSON,
} from "./helpers.js"

describe("parked continuation admission", () => {
  it.each(["observe", "pop-failed", "prompt-failed", "success"] as const)(
    "does not strand a resume probe: %s",
    async (scenario) => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => undefined)
      try {
        let now = 0
        const storage = new KeyFailStorage(scenario === "pop-failed" ? PARKED_KEY : "unused")
        seed(
          storage,
          SETTINGS_KEY,
          settingsJSON(scenario === "observe" ? "observe" : "active", {
            standard: [wireRef("prov", "a")],
          }),
        )
        seed(storage, PARKED_KEY, {
          version: 1,
          parked: [
            { id: "s1#1", sessionID: "s1", tier: "standard", reason: "all-blocked", parkedAt: 0 },
          ],
        })
        const session = new FakeSupervisorSession({ failPrompt: scenario === "prompt-failed" })
        const supervisor = makeSupervisor({ storage, session, clock: () => now })
        await supervisor.handleReport({
          kind: "model-request",
          sessionID: "s1",
          model: ref("prov", "a"),
          requestKind: "primary",
        } as never)
        for (let i = 0; i < 5; i += 1) {
          await supervisor.handleReport({ kind: "http-response", sessionID: "s1", status: 503 })
        }
        now = 40_000
        await supervisor.handleReport({ kind: "idle", sessionID: "s1" })
        if (scenario === "success") {
          await supervisor.handleReport({ kind: "prompt", sessionID: "s1" })
          await supervisor.handleReport({ kind: "execution-started", sessionID: "s1", at: now })
          await supervisor.handleReport({
            kind: "execution-succeeded",
            sessionID: "s1",
            at: now + 1,
          })
          await supervisor.handleReport({ kind: "prompt", sessionID: "s1" })
          expect((await supervisor.receipts())[0]?.decision).toMatchObject({
            kind: "apply",
            reason: "preferred",
          })
        } else {
          await supervisor.handleReport({ kind: "idle", sessionID: "s1" })
          if (scenario === "pop-failed") {
            await supervisor.handleReport({ kind: "prompt", sessionID: "s2" })
          }
          const decision = (await supervisor.receipts())[0]?.decision
          expect(decision).toMatchObject(
            scenario === "observe"
              ? { kind: "observe-only", would: { kind: "apply", reason: "probe" } }
              : { kind: "apply", reason: "probe" },
          )
        }
      } finally {
        errors.mockRestore()
      }
    },
  )

  it("resumes the parked tier rather than a later sticky session tier", async () => {
    const storage = new KeyFailStorage("unused")
    seed(
      storage,
      SETTINGS_KEY,
      settingsJSON("active", {
        quick: [wireRef("prov", "a")],
        standard: [wireRef("prov", "b")],
      }),
    )
    seed(storage, PARKED_KEY, {
      version: 1,
      parked: [
        { id: "s1#1", sessionID: "s1", tier: "standard", reason: "all-blocked", parkedAt: 0 },
      ],
    })
    const session = new FakeSupervisorSession()
    const supervisor = makeSupervisor({ storage, session })
    supervisor.noteTierRequest("s1", "quick")
    await supervisor.handleReport({ kind: "idle", sessionID: "s1" })
    expect(session.log).toContain("switch:s1:prov/b")
    expect((await supervisor.receipts())[0]?.decision).toMatchObject({
      kind: "apply",
      tier: "standard",
    })
  })
})
