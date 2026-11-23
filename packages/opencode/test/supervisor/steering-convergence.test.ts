// covers: ["ADP-002", "ADP-028", "ADP-054"]
// The host loads the plugin twice in one process (ADP-056). Both instances
// pump the same reports, but each keeps its own in-memory settings, session
// modes and tier requests. A change written through the instance that serves
// the control surface must steer the instance that routes the session too:
// production showed the same unit decided at `advanced` and `standard`
// because one instance never re-read the other's tier request.
import { describe, expect, it } from "vitest"

import { SETTINGS_KEY } from "@coool/adaptive-core/state/settings/types"

import { processLedger } from "../../src/adapters/opencode/process-ledger.js"
import { makeInfo, wireRef } from "../adapters/opencode/helpers.js"
import {
  FakeSupervisorSession,
  activeStorage,
  makeSupervisor,
  ref,
  seed,
  settingsJSON,
} from "./helpers.js"

const PROMPT = { kind: "prompt", sessionID: "s1" } as const

const INFOS = [makeInfo("prov", "a"), makeInfo("prov", "b"), makeInfo("prov", "c")]

function twoInstances(): {
  first: ReturnType<typeof makeSupervisor>
  second: ReturnType<typeof makeSupervisor>
  secondSession: FakeSupervisorSession
} {
  const holder = {}
  const storage = activeStorage()
  seed(
    storage,
    SETTINGS_KEY,
    settingsJSON("active", {
      standard: [wireRef("prov", "a"), wireRef("prov", "b")],
      advanced: [wireRef("prov", "c")],
    }),
  )
  const secondSession = new FakeSupervisorSession()
  const first = makeSupervisor({
    storage,
    session: new FakeSupervisorSession(),
    ledger: processLedger(holder),
    infos: INFOS,
  })
  const second = makeSupervisor({
    storage,
    session: secondSession,
    ledger: processLedger(holder),
    infos: INFOS,
  })
  return { first, second, secondSession }
}

/** The host reports a unit on the instance that pumps the session's events. */
async function start(supervisor: ReturnType<typeof makeSupervisor>): Promise<void> {
  await supervisor.handleReport(PROMPT)
  await supervisor.handleReport({ kind: "execution-started", sessionID: "s1", at: 10 })
  await supervisor.handleReport({
    kind: "model-request",
    sessionID: "s1",
    model: ref("prov", "a"),
    requestKind: "primary",
  })
}

describe("steering converges across duplicate instances", () => {
  it("routes at a tier request written through the other instance", async () => {
    const { first, second, secondSession } = twoInstances()
    await Promise.all([first.settings(), second.settings()])

    first.noteTierRequest("s1", "advanced")
    // Flush the fire-and-forget note before the other instance admits.
    await first.getTierRequest("s1")

    await start(second)
    expect(secondSession.log).toContain("switch:s1:prov/c")
    expect(secondSession.log).not.toContain("switch:s1:prov/b")
  })

  it("honors a settings change written through the other instance", async () => {
    const { first, second, secondSession } = twoInstances()
    await Promise.all([first.settings(), second.settings()])

    await first.updateSettings({ mode: "off" })
    await start(second)

    expect(secondSession.log).toEqual([])
  })

  it("honors a session mode written through the other instance", async () => {
    const { first, second, secondSession } = twoInstances()
    await Promise.all([first.settings(), second.settings()])

    await first.setSessionMode("s1", "off")
    await start(second)

    expect(secondSession.log).toEqual([])
  })

  it("serves the other instance's steering through the control surface", async () => {
    const { first, second } = twoInstances()
    await Promise.all([first.settings(), second.settings()])

    first.noteTierRequest("s1", "advanced")
    await first.getTierRequest("s1")
    expect(await second.getTierRequest("s1")).toBe("advanced")

    await first.setSessionMode("s1", "observe")
    expect(await second.getSessionMode("s1")).toBe("observe")

    await first.updateSettings({ mode: "off" })
    expect((await second.settings()).mode).toBe("off")
  })
})
