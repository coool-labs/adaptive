// covers: ["ADP-062"]
import { expect, it } from "vitest"
import { registerCommands, runCommand, SUBCOMMANDS } from "../src/host/commands.js"
import { PI_COPY } from "../src/ui/copy.js"
import { fakeApi } from "./support/api.js"
import { fakeView } from "./support/view.js"
import type { AdaptiveEnv } from "@coool/adaptive-core/flow/controller"

function setup() {
  const state = fakeApi()
  const view = fakeView()
  const called: string[] = []
  const action = (name: string) => () => {
    called.push(name)
    return Promise.resolve()
  }
  const env: AdaptiveEnv = {
    copy: PI_COPY,
    api: state.api,
    view: view.view,
    models: () => [],
    sessionID: "s",
    actions: {
      health: action("health"),
      parked: action("parked"),
      doctor: action("doctor"),
      preferences: action("preferences"),
      defaults: action("defaults"),
    },
  }
  const notices: string[] = []
  const ctx = {
    hasUI: true,
    ui: { notify: (message: string) => notices.push(message) },
    waitForIdle: action("idle"),
    isIdle: () => true,
  }
  const options = {
    env: () => Promise.resolve(env),
    resume: action("resume"),
    cancel: action("cancel"),
    clock: () => 1000,
  }
  return { ...state, ...view, env, called, ctx, options, notices }
}

it("runs every documented subcommand through shared flow or the owned host action", async () => {
  const state = setup()
  for (const command of ["", ...SUBCOMMANDS]) await runCommand(command, state.ctx, state.options)
  expect(state.called).toEqual(["health", "resume", "cancel", "doctor"])
  expect(state.patches).toEqual([{ mode: "observe" }, { mode: "off" }])
  expect(state.alerts.some((alert) => alert.message.includes("No decisions"))).toBe(true)
  expect(state.selects.some((select) => select.title === "Tier")).toBe(true)
  await runCommand("bogus", state.ctx, state.options)
  expect(state.toasts.at(-1)?.message).toContain("Unknown adaptive command")
})

it("shows the latest receipt from this session and validates observation save failures", async () => {
  const state = setup()
  state.env.api.receipts = () =>
    Promise.resolve([
      { id: 1, at: 0, sessionID: "other", decision: { kind: "defer", reason: "adaptive-off" } },
      { id: 2, at: 0, sessionID: "s", decision: { kind: "defer", reason: "adaptive-off" } },
    ])
  await runCommand("why", state.ctx, state.options)
  expect(state.alerts[0]?.message).toContain("id: 2")
  state.env.api.setSettings = () => Promise.resolve({ ok: false, errors: ["invalid mode"] })
  await runCommand(" observe   off ", state.ctx, state.options)
  expect(state.toasts.at(-1)).toEqual({ message: "invalid mode", variant: "error" })
  await runCommand("doctor", state.ctx, {
    ...state.options,
    env: () =>
      Promise.resolve({
        copy: state.env.copy,
        api: state.env.api,
        view: state.env.view,
        models: state.env.models,
      }),
  })
  await runCommand("", { ...state.ctx, hasUI: false }, state.options)
  expect(state.notices.at(-1)).toContain("interactive or RPC")
})

it("registers completions and guards shortcuts/command failures without waking a model", async () => {
  const state = setup()
  let command:
    | Parameters<Parameters<typeof registerCommands<typeof state.ctx>>[0]["registerCommand"]>[1]
    | undefined
  let shortcut:
    | Parameters<Parameters<typeof registerCommands<typeof state.ctx>>[0]["registerShortcut"]>[1]
    | undefined
  registerCommands(
    {
      registerCommand: (name, spec) => {
        expect(name).toBe("adaptive")
        command = spec
      },
      registerShortcut: (key, spec) => {
        expect(key).toBe("ctrl+alt+a")
        shortcut = spec
      },
    },
    state.options,
  )
  if (command === undefined || shortcut === undefined)
    throw new Error("command registrations missing")
  expect(command.getArgumentCompletions("observe").map((item) => item.value)).toEqual([
    "observe on",
    "observe off",
  ])
  await command.handler("doctor", state.ctx)
  await shortcut.handler(state.ctx)
  await shortcut.handler({ ...state.ctx, isIdle: () => false })
  const failed = { ...state.options, env: () => Promise.reject(new Error("SECRET")) }
  registerCommands(
    {
      registerCommand: (_name, spec) => {
        command = spec
      },
      registerShortcut: (_key, spec) => {
        shortcut = spec
      },
    },
    failed,
  )
  await command.handler("", state.ctx)
  await shortcut.handler(state.ctx)
  expect(state.notices.join("\n")).not.toContain("SECRET")
  expect(state.notices.join("\n")).toContain("could not open")
})
