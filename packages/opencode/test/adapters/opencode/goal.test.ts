// covers: ["ADP-025"]
import { describe, expect, it } from "vitest"

import { Goal } from "@opencode/schema/goal"
import { goalSurface } from "../../../src/adapters/opencode/goal.js"

/** Rpc domain stand-in: records the definition used, scripts the goal read. */
function fakeRpc(state: unknown): { definitions: string[]; calls: unknown[]; source: never } {
  const definitions: string[] = []
  const calls: unknown[] = []
  const source = ((definition: { id: string }) => {
    definitions.push(definition.id)
    return {
      get: (input: unknown) => {
        calls.push(input)
        return Promise.resolve(state)
      },
    }
  }) as never
  return { definitions, calls, source }
}

function fakeSession() {
  const commands: { sessionID: string; name: string; text: string }[] = []
  const source = {
    command: (input: { sessionID: string; name: string; text: string }) => {
      commands.push(input)
      return Promise.resolve()
    },
  }
  return { commands, source }
}

describe("goalSurface", () => {
  it("reads a session's goal through the host's goal rpc", async () => {
    const rpc = fakeRpc({
      id: "g1",
      objective: "ship the fix",
      status: "paused",
      reason: "The session failed: quota",
      rounds: 2,
      maxRounds: 50,
      boot: "b",
      updatedAt: 7,
    })
    const session = fakeSession()
    const surface = goalSurface(rpc.source, session.source)
    expect(await surface.get("s1")).toEqual({
      status: "paused",
      reason: "The session failed: quota",
    })
    expect(rpc.definitions).toEqual([Goal.Definition.id])
    expect(rpc.calls).toEqual([{ sessionID: "s1" }])
  })

  it("maps a goal without a reason and a missing goal faithfully", async () => {
    const rpc = fakeRpc({
      id: "g1",
      objective: "ship the fix",
      status: "active",
      rounds: 1,
      maxRounds: 50,
      boot: "b",
      updatedAt: 7,
    })
    const session = fakeSession()
    const surface = goalSurface(rpc.source, session.source)
    expect(await surface.get("s1")).toEqual({ status: "active" })
    expect(await goalSurface(fakeRpc(null).source, session.source).get("s1")).toBeNull()
  })

  it("resumes through the host's /goal server command", async () => {
    const rpc = fakeRpc(null)
    const session = fakeSession()
    const surface = goalSurface(rpc.source, session.source)
    await surface.resume("s1")
    expect(session.commands).toEqual([{ sessionID: "s1", name: "goal", text: "resume" }])
  })

  it("lets rpc errors propagate (the supervisor fail-opens around them)", async () => {
    const source = (() => ({
      get: () => Promise.reject(new Error("rpc unavailable")),
    })) as never
    const surface = goalSurface(source, fakeSession().source)
    await expect(surface.get("s1")).rejects.toThrow("rpc unavailable")
  })
})
