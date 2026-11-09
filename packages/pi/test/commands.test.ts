// covers: ["ADP-062"]
import { expect, it } from "vitest"
import { registerCommands, runCommand } from "../src/host/commands.js"
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
      resume: () => {
        called.push("resume")
        return Promise.resolve("resumed")
      },
      doctor: () => {
        called.push("doctor")
        return Promise.resolve([{ state: "ok", message: "fine" }])
      },
    },
  }
  const notices: string[] = []
  const ctx = {
    hasUI: true,
    ui: { notify: (message: string) => notices.push(message) },
    waitForIdle: action("idle"),
    isIdle: () => true,
  }
  const options = { env: () => Promise.resolve(env) }
  return { ...state, ...view, env, called, ctx, options, notices }
}

it("hands every subcommand to the shared runner with this session's environment", async () => {
  const state = setup()
  await runCommand(" observe   on ", state.ctx, state.options)
  await runCommand("resume", state.ctx, state.options)
  await runCommand("doctor", state.ctx, state.options)
  expect(state.patches).toEqual([{ mode: "observe" }])
  expect(state.called).toEqual(["resume", "doctor"])
  expect(state.tables.at(-1)).toEqual({
    title: "Adaptive doctor",
    lines: ["All 1 checks OK", "OK fine"],
  })
  await runCommand("cancel", state.ctx, state.options)
  expect(state.toasts.at(-1)?.message).toBe(
    "Unknown adaptive command. Use: status, why, tiers, resume, observe on, observe off, doctor.",
  )
})

it("refuses without a UI instead of opening a dialog nobody can answer", async () => {
  const state = setup()
  await runCommand("", { ...state.ctx, hasUI: false }, state.options)
  expect(state.notices.at(-1)).toContain("interactive or RPC")
  expect(state.selects).toEqual([])
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
