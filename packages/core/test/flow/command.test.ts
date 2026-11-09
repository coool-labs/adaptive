/**
 * `/adaptive <subcommand>`: one parser for every host. Action-backed
 * subcommands exist only where the host wires the action, and the unknown
 * command hint lists exactly what this host can run.
 */
// covers: ["ADP-062"]
import { describe, expect, it } from "vitest"
import type { AdaptiveActions } from "../../src/flow/actions.js"
import {
  ADAPTIVE_SUBCOMMANDS,
  adaptiveSubcommands,
  runAdaptiveCommand,
} from "../../src/flow/command.js"
import type { Receipt } from "../../src/state/receipts/index.js"
import { scripted, snapshot } from "./fake-env.js"

function allActions(calls: string[]): AdaptiveActions {
  return {
    resetHealth: () => Promise.resolve(),
    resume: (sessionID) => {
      calls.push(`resume:${sessionID}`)
      return Promise.resolve("resumed")
    },
    cancel: (sessionID) => {
      calls.push(`cancel:${sessionID}`)
      return Promise.resolve("cancelled")
    },
    tools: () => {
      calls.push("tools")
      return Promise.resolve()
    },
    doctor: () => Promise.resolve([{ state: "ok", message: "fine" }]),
  }
}

describe("adaptiveSubcommands", () => {
  it("lists action-backed subcommands only when wired", () => {
    expect(adaptiveSubcommands(allActions([]))).toEqual([...ADAPTIVE_SUBCOMMANDS])
    expect(adaptiveSubcommands(undefined)).toEqual([
      "status",
      "why",
      "tiers",
      "observe on",
      "observe off",
    ])
  })
})

describe("runAdaptiveCommand", () => {
  it("opens the menu, or a screen of it, for menu subcommands", async () => {
    for (const [input, title] of [
      ["", "Adaptive (observe)"],
      ["  status ", "Adaptive (observe)"],
      ["tiers", "Tier"],
    ] as const) {
      const host = scripted()
      await runAdaptiveCommand(host.env, input)
      expect(host.selects[0]?.title).toBe(title)
    }
  })

  it("runs the wired operations for this session", async () => {
    const calls: string[] = []
    const host = scripted({ sessionID: "s1", actions: allActions(calls) })
    await runAdaptiveCommand(host.env, "resume")
    await runAdaptiveCommand(host.env, "cancel")
    await runAdaptiveCommand(host.env, "doctor")
    await runAdaptiveCommand(host.env, "health")
    await runAdaptiveCommand(host.env, "tools")
    expect(calls).toEqual(["resume:s1", "cancel:s1", "tools"])
    expect(host.toasts).toEqual([
      { message: "Resuming parked work", variant: "success" },
      { message: "Parked work cancelled", variant: "success" },
    ])
    expect(host.tables).toEqual([
      { title: "Adaptive doctor", lines: ["All 1 checks OK", "OK fine"] },
    ])
    expect(host.alerts.at(-1)?.title).toBe("Health")
  })

  it("rejects unwired and unknown subcommands with what this host supports", async () => {
    const host = scripted()
    for (const input of ["resume", "cancel", "doctor", "health", "tools", "bogus"])
      await runAdaptiveCommand(host.env, input)
    const hint = "Unknown adaptive command. Use: status, why, tiers, observe on, observe off."
    expect(host.toasts).toEqual(
      Array.from({ length: 6 }, () => ({ message: hint, variant: "error" })),
    )
  })

  it("switches observation through settings without touching the session's model", async () => {
    const host = scripted()
    await runAdaptiveCommand(host.env, "observe   on")
    await runAdaptiveCommand(host.env, "observe off")
    expect(host.patches).toEqual([{ mode: "observe" }, { mode: "off" }])
    expect(host.toasts.map((toast) => toast.message)).toEqual([
      "Observation setting saved. Your selected model is unchanged.",
      "Observation setting saved. Your selected model is unchanged.",
    ])
    const rejected = scripted({ patch: { ok: false, errors: ["invalid mode", "busy"] } })
    await runAdaptiveCommand(rejected.env, "observe on")
    expect(rejected.toasts).toEqual([{ message: "invalid mode; busy", variant: "error" }])
  })

  it("explains the latest decision in this session", async () => {
    const receipt = (id: number, sessionID: string): Receipt => ({
      id,
      at: 0,
      sessionID,
      decision: { kind: "defer", reason: "routing-defer" },
    })
    const host = scripted({ sessionID: "s1", receipts: [receipt(3, "other"), receipt(2, "s1")] })
    await runAdaptiveCommand(host.env, "why")
    expect(host.alerts[0]?.title).toBe("Latest decision")
    expect(host.alerts[0]?.message).toContain("id: 2")
    const empty = scripted({ sessionID: "s1", status: snapshot(), clock: false })
    await runAdaptiveCommand(empty.env, "why")
    expect(empty.alerts).toEqual([
      { title: "Latest decision", message: "No decisions recorded in this session yet." },
    ])
    const unclocked = scripted({ sessionID: "s1", receipts: [receipt(2, "s1")], clock: false })
    await runAdaptiveCommand(unclocked.env, "why")
    expect(unclocked.alerts[0]?.message).toContain("id: 2")
  })
})
