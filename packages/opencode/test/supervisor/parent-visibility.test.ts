// covers: ["ADP-031", "ADP-052"]
import { describe, expect, it, vi } from "vitest"
import { wireRef } from "../adapters/opencode/helpers.js"
import {
  activeStorage,
  FakeSupervisorSession,
  flush,
  makeSupervisor,
  seed,
  settingsJSON,
} from "./helpers.js"
import type { ParentNarration } from "../../src/supervisor/index.js"
import type { ModelRef } from "@coool/adaptive-core/routing/work-unit/types"

const QUOTA = {
  kind: "execution-failed",
  sessionID: "s1",
  at: 20,
  error: { type: "UnknownError", message: "Model quota exhausted" },
} as const

function narration(): { log: string[]; parent: ParentNarration } {
  const log: string[] = []
  return {
    log,
    parent: {
      instruct: (parentID: string) => {
        log.push(`instruct:${parentID}`)
        return Promise.resolve()
      },
      resumed: (parentID: string, model: ModelRef) => {
        log.push(`resumed:${parentID}:${model.providerID}/${model.id}`)
        return Promise.resolve()
      },
    },
  }
}

async function startChild(supervisor: ReturnType<typeof makeSupervisor>): Promise<void> {
  await supervisor.handleReport({ kind: "prompt", sessionID: "s1" })
  await supervisor.handleReport({ kind: "execution-started", sessionID: "s1", at: 10 })
  await supervisor.handleReport({
    kind: "model-request",
    sessionID: "s1",
    model: { providerID: "prov", id: "a" },
    requestKind: "primary",
  })
}

describe("parent visibility", () => {
  it("instructs an orchestrator once, however many children it spawns", async () => {
    const { log, parent } = narration()
    const supervisor = makeSupervisor({
      storage: activeStorage(),
      session: new FakeSupervisorSession(),
      parent,
    })
    await supervisor.handleReport({
      kind: "agent-selected",
      sessionID: "c1",
      agent: "general",
      parentID: "p1",
    })
    await supervisor.handleReport({
      kind: "agent-selected",
      sessionID: "c2",
      agent: "general",
      parentID: "p1",
    })
    await flush()
    expect(log).toEqual(["instruct:p1"])
  })

  it("announces a child's availability recovery to its parent", async () => {
    const { log, parent } = narration()
    const session = new FakeSupervisorSession()
    const supervisor = makeSupervisor({ storage: activeStorage(), session, parent })
    await supervisor.handleReport({
      kind: "agent-selected",
      sessionID: "s1",
      agent: "general",
      parentID: "p1",
    })
    await startChild(supervisor)
    await supervisor.handleReport(QUOTA)
    await flush()
    expect(session.log).toContain("switch:s1:prov/b")
    expect(log).toEqual(["instruct:p1", "resumed:p1:prov/b"])
  })

  it("never announces a top-level session", async () => {
    const { log, parent } = narration()
    const session = new FakeSupervisorSession()
    const supervisor = makeSupervisor({ storage: activeStorage(), session, parent })
    await supervisor.handleReport({ kind: "agent-selected", sessionID: "s1", agent: "build" })
    await startChild(supervisor)
    await supervisor.handleReport(QUOTA)
    await flush()
    expect(session.log).toContain("switch:s1:prov/b")
    expect(log).toEqual([])
  })

  it("announces nothing when the child's tier is exhausted instead of resumed", async () => {
    const { log, parent } = narration()
    const storage = activeStorage()
    seed(
      storage,
      "coool.adaptive/settings",
      settingsJSON("active", { standard: [wireRef("prov", "a")] }),
    )
    const supervisor = makeSupervisor({ storage, session: new FakeSupervisorSession(), parent })
    await supervisor.handleReport({
      kind: "agent-selected",
      sessionID: "s1",
      agent: "general",
      parentID: "p1",
    })
    await startChild(supervisor)
    await supervisor.handleReport(QUOTA)
    await flush()
    expect(log).toEqual(["instruct:p1"])
  })

  it("keeps recovering when the parent surface throws", async () => {
    const failure = new Error("no instruction surface")
    const parent: ParentNarration = {
      instruct: () => Promise.reject(failure),
      resumed: () => Promise.reject(failure),
    }
    const session = new FakeSupervisorSession()
    const supervisor = makeSupervisor({ storage: activeStorage(), session, parent })
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined)
    try {
      await supervisor.handleReport({
        kind: "agent-selected",
        sessionID: "s1",
        agent: "general",
        parentID: "p1",
      })
      await startChild(supervisor)
      await supervisor.handleReport(QUOTA)
      await flush()
    } finally {
      logged.mockRestore()
    }
    expect(session.log).toContain("switch:s1:prov/b")
    expect(session.log.some((line) => line.startsWith("prompt:s1:"))).toBe(true)
  })

  it("remains silent when the host has no narration surface", async () => {
    const session = new FakeSupervisorSession()
    const supervisor = makeSupervisor({ storage: activeStorage(), session })
    await supervisor.handleReport({
      kind: "agent-selected",
      sessionID: "s1",
      agent: "general",
      parentID: "p1",
    })
    await startChild(supervisor)
    await supervisor.handleReport(QUOTA)
    await flush()
    expect(session.log).toContain("switch:s1:prov/b")
  })

  it("stops instructing new orchestrators past the bounded parent cache", async () => {
    const { log, parent } = narration()
    const supervisor = makeSupervisor({
      storage: activeStorage(),
      session: new FakeSupervisorSession(),
      parent,
    })
    for (let index = 0; index < 1025; index += 1) {
      await supervisor.handleReport({
        kind: "agent-selected",
        sessionID: `c${String(index)}`,
        agent: "general",
        parentID: `p${String(index)}`,
      })
    }
    await flush()
    expect(log).toHaveLength(1024)
    expect(log).not.toContain("instruct:p1024")
  })
})
