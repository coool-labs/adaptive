/**
 * Web command tests (ADP-034): the slash command the browser UI can reach.
 * The host's web app never mounts plugin GUI bundles, so a text command is the
 * only surface there. Behavior is asserted through the replies it posts.
 */
// covers: ["ADP-034"]
import { afterEach, describe, expect, it, vi } from "vitest"

import { adaptiveCommand } from "../../../src/adapters/opencode/command.js"
import type { CommandSource } from "../../../src/adapters/opencode/command.js"
import type { OperatingMode } from "../../../src/core/scheduler/types.js"
import type { StatusSnapshot, TierResourceStatus } from "../../../src/rpc/status.js"

const HELP = [
  "Switch the mode:",
  "/web-adaptive off — Adaptive does nothing",
  "/web-adaptive observe — Record decisions without applying them",
  "/web-adaptive on — Apply routing and recovery decisions",
  "/web-adaptive — show this status again",
]

const DESCRIPTION = {
  off: "Adaptive does nothing",
  observe: "Record decisions without applying them",
  active: "Apply routing and recovery decisions",
} as const

const REF = { providerID: "prov", id: "a" }

function snapshot(
  mode: OperatingMode,
  resources: readonly Partial<TierResourceStatus>[],
  pin: StatusSnapshot["pin"] = null,
): StatusSnapshot {
  return {
    mode,
    pin,
    tiers: {
      quick: [],
      standard: resources.map((resource) => ({
        ref: REF,
        health: "healthy",
        breaker: "closed",
        windowed: false,
        windowUntil: null,
        usedPercent: null,
        resetAt: null,
        ...resource,
      })),
      advanced: [],
    },
    parked: 0,
    waiting: [],
    receipts: 0,
  }
}

function setup(overrides: Partial<CommandSource> = {}) {
  const said: { sessionID: string; text: string }[] = []
  const setMode = vi.fn<CommandSource["setMode"]>(() => Promise.resolve({ ok: true }))
  const source: CommandSource = {
    status: () => Promise.resolve(snapshot("active", [{}])),
    setMode,
    ...overrides,
  }
  const command = adaptiveCommand(source, (sessionID, text) => {
    said.push({ sessionID, text })
    return Promise.resolve()
  })
  /** The messages one invocation posts, in order. */
  const run = async (text: string): Promise<string[]> => {
    const before = said.length
    await command.execute({ sessionID: "s1", prompt: { text } })
    return said.slice(before).map((message) => message.text)
  }
  return { command, run, said, setMode }
}

describe("web command", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("is named apart from the TUI's /adaptive", () => {
    const { command } = setup()
    expect(command.name).toBe("web-adaptive")
    expect(command.description).toContain("on | off")
  })

  it.each(["/web-adaptive", "/web-adaptive status", "status", "  /WEB-ADAPTIVE   Status "])(
    "reports the mode and the models for %j, ending with how to switch",
    async (text) => {
      const { run, said } = setup()
      expect(await run(text)).toEqual([
        "Adaptive: active — Apply routing and recovery decisions.",
        "prov/a (standard, healthy)",
        ...HELP,
      ])
      expect(said.every((message) => message.sessionID === "s1")).toBe(true)
    },
  )

  it("lists every model with its window, usage and pin", async () => {
    const { run } = setup({
      status: () =>
        Promise.resolve(
          snapshot(
            "observe",
            [
              { health: "unavailable", breaker: "open" },
              { ref: { providerID: "prov", id: "b", variant: "high" }, usedPercent: 40 },
            ],
            { providerID: "prov", id: "b", variant: "high" },
          ),
        ),
    })
    expect((await run("/web-adaptive")).slice(1, 3)).toEqual([
      "prov/a (standard, unavailable, breaker open)",
      "prov/b@high (standard, healthy, used 40% (pinned))",
    ])
  })

  it("says so when no models are configured", async () => {
    const { run } = setup({ status: () => Promise.resolve(snapshot("observe", [])) })
    expect(await run("/web-adaptive")).toEqual([
      "Adaptive: observe — Record decisions without applying them.",
      "No models configured yet.",
      ...HELP,
    ])
  })

  it.each([
    ["off", "off"],
    ["observe", "observe"],
    ["active", "active"],
    ["on", "active"],
    ["/web-adaptive OFF", "off"],
  ] as const)("switches the mode for %j", async (text, mode) => {
    const { run, setMode } = setup()
    expect(await run(text)).toEqual([`Adaptive switched to ${mode} — ${DESCRIPTION[mode]}.`])
    expect(setMode).toHaveBeenCalledExactlyOnceWith(mode)
  })

  it("reports a rejected switch with the host's reasons", async () => {
    const { run } = setup({
      setMode: () => Promise.resolve({ ok: false, errors: ["mode: nope", "internal error"] }),
    })
    expect(await run("off")).toEqual(["Adaptive could not switch mode: mode: nope; internal error"])
  })

  it("explains the usage for anything else and changes nothing", async () => {
    const { run, setMode } = setup()
    expect(await run("/web-adaptive banana")).toEqual([
      "Usage: /web-adaptive [status | on | off | observe | active]",
    ])
    expect(setMode).not.toHaveBeenCalled()
  })

  it("answers a failed status read instead of throwing (fail-open)", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const { run } = setup({ status: () => Promise.reject(new Error("storage down")) })
    expect(await run("/web-adaptive")).toEqual(["Adaptive could not complete that command."])
    expect(errors.mock.calls.some((call) => String(call[0]).includes("command"))).toBe(true)
  })
})
