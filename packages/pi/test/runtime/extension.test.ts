// covers: ["ADP-003", "ADP-010", "ADP-011", "ADP-013", "ADP-014", "ADP-015", "ADP-022", "ADP-024", "ADP-028", "ADP-029", "ADP-032", "ADP-055", "ADP-056", "ADP-057", "ADP-059", "ADP-060", "ADP-061", "ADP-062", "ADP-063", "ADP-064"]
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import type { AgentSession, ExtensionUIContext } from "@earendil-works/pi-coding-agent"
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  VERSION,
} from "@earendil-works/pi-coding-agent"
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux"
import type { SettingsV1 } from "@coool/adaptive-core/state/settings/types"
import { defaultSettings } from "@coool/adaptive-core/state/settings/parse"
import { registerAdaptive } from "../../src/host/extension.js"
import { jsonFile, type JsonFile } from "../../src/store.js"
import { readSettings } from "../../src/settings.js"
import { withHealth } from "../../src/health.js"
import type { AdaptiveSources } from "../../src/host/extension.js"

interface Harness {
  readonly cwd: string
  readonly runtime: ModelRuntime
  readonly faux: ReturnType<typeof fauxProvider>
  readonly session: AgentSession
  readonly settingsReads: () => number
  readonly probeCalls: readonly string[]
  readonly sources: AdaptiveSources
  readonly settingsFile: JsonFile
  /** Everything Adaptive showed through the dialogs of the scripted UI. */
  readonly shown: readonly string[]
  readonly waits: readonly number[]
  setOnWait(callback: (() => void) | undefined): void
}

const settings = {
  ...defaultSettings(),
  inviteDismissed: true,
  mode: "active" as const,
  tiers: {
    quick: [{ providerID: "adaptive-faux", id: "quick" }],
    standard: [{ providerID: "adaptive-faux", id: "standard" }],
    advanced: [{ providerID: "adaptive-faux", id: "advanced" }],
  },
}

/** Scripted answers for the dialogs of an RPC-style host; omitted means no UI. */
interface Dialogs {
  select(title: string, options: readonly string[]): string | undefined
  confirm(title: string, message: string, harness: Pick<Harness, "settingsFile">): Promise<boolean>
}

interface SessionOptions {
  readonly settings?: SettingsV1
  readonly dialogs?: Dialogs
  /** Pi's native retry; off unless a scenario exercises it. */
  readonly retry?: boolean
}

/** A real Pi 1.5 session with Adaptive and a scripted local faux provider. */
async function withSession(
  run: (harness: Harness) => Promise<void>,
  options: SessionOptions = {},
): Promise<void> {
  const routed = options.settings ?? settings
  const cwd = await mkdtemp(join(tmpdir(), "adaptive-pi-sdk-"))
  try {
    const runtime = await ModelRuntime.create({
      authPath: join(cwd, "auth.json"),
      modelsPath: null,
      modelsStorePath: join(cwd, "models.json"),
      refreshOnCreate: false,
    })
    const faux = fauxProvider({
      provider: "adaptive-faux",
      models: [{ id: "quick" }, { id: "standard" }, { id: "standard-b" }, { id: "advanced" }],
    })
    runtime.registerNativeProvider(faux.provider)
    await runtime.setRuntimeApiKey("adaptive-faux", "local-faux-test-data")
    await runtime.refresh()
    let settingsReads = 0
    let ids = 0
    const settingsFile = jsonFile(join(cwd, "adaptive", "settings.json"))
    await settingsFile.update(() => ({ next: routed, result: undefined }))
    const shown: string[] = []
    const probeCalls: string[] = []
    const waits: number[] = []
    let now = 1_000
    let onWait: (() => void) | undefined
    let sources: AdaptiveSources | undefined
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: cwd,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      extensionFactories: [
        (pi) => {
          const resolved: AdaptiveSources = {
            capacity: { file: jsonFile(join(cwd, "adaptive", "capacity.json")), clock: () => now },
            settings: () => {
              settingsReads += 1
              return readSettings(settingsFile)
            },
            capabilities: () =>
              Promise.resolve(
                faux.models.map((model) => ({
                  providerID: model.provider,
                  id: model.id,
                  tools: true,
                })),
              ),
            newId: () => {
              ids += 1
              return `id-${String(ids)}`
            },
            health: {
              file: jsonFile(join(cwd, "adaptive", "health.json")),
              clock: () => now,
              newId: () => {
                ids += 1
                return `probe-${String(ids)}`
              },
            },
            receipts: jsonFile(join(cwd, "adaptive", "receipts.json")),
            preferences: jsonFile(join(cwd, "adaptive", "preferences.json")),
            parking: {
              file: jsonFile(join(cwd, "adaptive", "parked.json")),
              clock: () => now,
              timer: (callback, delay) => {
                waits.push(delay)
                let cancelled = false
                queueMicrotask(() => {
                  onWait?.()
                  if (!cancelled) {
                    now += delay
                    callback()
                  }
                })
                return () => {
                  cancelled = true
                }
              },
            },
          }
          sources = resolved
          registerAdaptive(pi, resolved, {
            settings: settingsFile,
            version: VERSION,
            minimum: "1.5.0",
            testedUpTo: undefined,
          })
          pi.registerTool({
            name: "adaptive_test_probe",
            label: "Probe",
            description: "Deterministic local tool fixture",
            parameters: { type: "object", properties: {}, additionalProperties: false },
            execute: () => {
              probeCalls.push("probe")
              return Promise.resolve({ content: [{ type: "text", text: "PROBE_OK" }], details: {} })
            },
          })
        },
      ],
    })
    await loader.reload()
    const physical = runtime.getModel("adaptive-faux", "standard")
    if (physical === undefined) throw new Error("faux model missing")
    const { session } = await createAgentSession({
      cwd,
      agentDir: cwd,
      modelRuntime: runtime,
      model: physical,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: options.retry ?? false, maxRetries: 3, baseDelayMs: 1 },
      }),
    })
    try {
      const dialogs = options.dialogs
      const base = session.extensionRunner.getUIContext()
      const harnessSettings = { settingsFile }
      await session.bindExtensions(
        dialogs === undefined
          ? {}
          : {
              mode: "rpc",
              uiContext: {
                ...base,
                select: (title, choices) => {
                  shown.push(`${title}\n${choices.join("\n")}`)
                  return Promise.resolve(dialogs.select(title, choices))
                },
                confirm: (title, message) => {
                  shown.push(`${title}\n${message}`)
                  return dialogs.confirm(title, message, harnessSettings)
                },
                notify: (message) => {
                  shown.push(message)
                },
              } satisfies ExtensionUIContext,
            },
      )
      session.setActiveToolsByName([])
      if (sources === undefined) throw new Error("sources missing")
      await run({
        cwd,
        runtime,
        faux,
        session,
        settingsReads: () => settingsReads,
        probeCalls,
        sources,
        settingsFile,
        shown,
        waits,
        setOnWait: (callback) => {
          onWait = callback
        },
      })
    } finally {
      session.dispose()
    }
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}

async function selectVirtual(harness: Harness, id: string): Promise<void> {
  const virtual = harness.runtime.getModel("adaptive", id)
  if (virtual === undefined) throw new Error(`missing virtual ${id}`)
  await harness.session.setModel(virtual)
}

function assistants(session: AgentSession) {
  return session.agent.state.messages.filter((message) => message.role === "assistant")
}

const OVERFLOW = "prompt is too long: 250000 tokens > 200000 maximum"

it("loads the real extension binding and dispatches every virtual entry through Pi 1.5", async () => {
  await withSession(async (harness) => {
    const { faux, session } = harness
    for (const id of ["auto", "quick", "standard", "advanced"]) {
      await selectVirtual(harness, id)
      faux.setResponses([fauxAssistantMessage(`Answered ${id}`)])
      await session.prompt("Test routing")
      const assistant = assistants(session).at(-1)
      expect(assistant?.model).toBe(id === "auto" ? "standard" : id)
      expect(assistant?.stopReason).toBe("stop")
    }
    const physical = harness.runtime.getModel("adaptive-faux", "standard")
    if (physical === undefined) throw new Error("faux model missing")
    await session.setModel(physical)
    faux.setResponses([fauxAssistantMessage("Manual choice")])
    await session.prompt("Manual model")
    expect(assistants(session).at(-1)?.model).toBe("standard")
    expect(faux.state.callCount).toBe(5)
    // Preview and routing share the scheduler; physical-model runs read none.
    expect(harness.settingsReads()).toBe(19)
    await selectVirtual(harness, "auto")
    session.setActiveToolsByName(["adaptive_test_probe"])
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("adaptive_test_probe", {})]),
      fauxAssistantMessage("Tool continuation complete"),
    ])
    await session.prompt("Call the local probe")
    expect(harness.probeCalls).toEqual(["probe"])
    expect(faux.state.callCount).toBe(7)
    expect(harness.settingsReads()).toBe(25)
    const toolRun = assistants(session).slice(-2)
    expect(toolRun.map((message) => message.model)).toEqual(["standard", "standard"])
    expect(toolRun.at(-1)?.stopReason).toBe("stop")
  })
})

it("continues a capability failure one tier up with recorded evidence, once per tier", async () => {
  await withSession(async (harness) => {
    const { faux, session } = harness
    await selectVirtual(harness, "auto")
    session.setActiveToolsByName(["adaptive_escalate"])
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("adaptive_escalate", { reason: "too large", evidence: "the diff is huge" }),
      ]),
      fauxAssistantMessage("", { stopReason: "error", errorMessage: OVERFLOW }),
      fauxAssistantMessage("Recovered on the stronger tier"),
    ])
    await session.prompt("Hard task")
    expect(assistants(session).map((message) => message.model)).toEqual([
      "standard",
      "standard",
      "advanced",
    ])
    expect(
      assistants(session)
        .map((message) => message.stopReason)
        .slice(1),
    ).toEqual(["error", "stop"])
    const recorded = session.agent.state.messages.find(
      (message) => message.role === "toolResult" && message.toolName === "adaptive_escalate",
    )
    expect(recorded).toMatchObject({
      details: { reason: "too large", evidence: "the diff is huge" },
    })
    const hidden = session.sessionManager
      .getBranch()
      .filter((entry) => entry.type === "custom_message")
    expect(hidden).toMatchObject([
      { customType: "adaptive.continuation", display: false, details: { tier: "advanced" } },
    ])
    // A new prompt is a new task: escalation never carries over.
    faux.setResponses([fauxAssistantMessage("Fresh task")])
    await session.prompt("Next task")
    expect(assistants(session).at(-1)?.model).toBe("standard")
    expect(faux.state.callCount).toBe(4)
  })
})

it("steers new tasks with adaptive_tier and bounds escalation per task", async () => {
  await withSession(async (harness) => {
    const { faux, session } = harness
    await selectVirtual(harness, "auto")
    session.setActiveToolsByName(["adaptive_tier"])
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("adaptive_tier", { tier: "quick" })]),
      fauxAssistantMessage("Noted"),
    ])
    await session.prompt("Routine edits ahead")
    // The request applies from the next user prompt; the current task stays put.
    expect(assistants(session).map((message) => message.model)).toEqual(["standard", "standard"])
    const failure = fauxAssistantMessage("", { stopReason: "error", errorMessage: OVERFLOW })
    faux.setResponses([failure, failure, failure, fauxAssistantMessage("never reached")])
    await session.prompt("Routine edit")
    expect(
      assistants(session)
        .slice(2)
        .map((message) => [message.model, message.stopReason]),
    ).toEqual([
      ["quick", "error"],
      ["standard", "error"],
      ["advanced", "error"],
    ])
    expect(faux.state.callCount).toBe(5)
  })
})

it("never escalates a pinned virtual tier", async () => {
  await withSession(async (harness) => {
    const { faux, session } = harness
    await selectVirtual(harness, "standard")
    faux.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: OVERFLOW }),
      fauxAssistantMessage("never reached"),
    ])
    await session.prompt("Pinned task")
    expect(assistants(session).map((message) => [message.model, message.stopReason])).toEqual([
      ["standard", "error"],
    ])
    expect(faux.state.callCount).toBe(1)
  })
})

const twoStandard = {
  ...settings,
  tiers: {
    ...settings.tiers,
    standard: [
      { providerID: "adaptive-faux", id: "standard" },
      { providerID: "adaptive-faux", id: "standard-b" },
    ],
  },
}
const OUTAGE = "503 status code (no body)"
const RATE_LIMITED = "429 Rate limit reached for requests per min"
const QUOTA = "429 You exceeded your current quota, please check your plan and billing details."
const AUTH = "401 Incorrect API key provided: sk-***."

function failing(errorMessage: string) {
  return fauxAssistantMessage("", { stopReason: "error", errorMessage })
}

/** Every routed response on the branch, including attempts Pi retried. */
function outcomes(session: AgentSession) {
  return session.sessionManager
    .getBranch()
    .flatMap((entry) =>
      entry.type === "message" && entry.message.role === "assistant"
        ? [[entry.message.model, entry.message.stopReason]]
        : [],
    )
}

function continuations(session: AgentSession) {
  return session.sessionManager
    .getBranch()
    .filter(
      (entry) => entry.type === "custom_message" && entry.customType === "adaptive.continuation",
    )
}

async function healthFile(harness: Harness): Promise<unknown> {
  return JSON.parse(await readFile(join(harness.cwd, "adaptive", "health.json"), "utf8"))
}

it("redirects Pi's native retry after a 503 to another model of the same tier", async () => {
  await withSession(
    async (harness) => {
      const { faux, session } = harness
      await selectVirtual(harness, "auto")
      faux.setResponses([failing(OUTAGE), fauxAssistantMessage("Recovered")])
      await session.prompt("Outage")
      expect(outcomes(session)).toEqual([
        ["standard", "error"],
        ["standard-b", "stop"],
      ])
      expect(faux.state.callCount).toBe(2)
      expect(continuations(session)).toEqual([])
    },
    { settings: twoStandard, retry: true },
  )
})

it("redirects after a 429 and shares the rate limit through the health file", async () => {
  await withSession(
    async (harness) => {
      const { faux, session } = harness
      await selectVirtual(harness, "auto")
      faux.setResponses([failing(RATE_LIMITED), fauxAssistantMessage("Recovered")])
      await session.prompt("Rate limited")
      expect(outcomes(session)).toEqual([
        ["standard", "error"],
        ["standard-b", "stop"],
      ])
      expect(await healthFile(harness)).toMatchObject({
        records: expect.arrayContaining([
          expect.objectContaining({
            key: { providerID: "adaptive-faux", modelID: "standard" },
            health: "rate_limited",
          }),
        ]) as unknown,
      })
      // The next task avoids the limited model from its first request.
      faux.setResponses([fauxAssistantMessage("Fresh task")])
      await session.prompt("Next task")
      expect(assistants(session).at(-1)?.model).toBe("standard-b")
    },
    { settings: twoStandard, retry: true },
  )
})

it("restarts a quota failure Pi does not retry on the same tier through a hidden continuation", async () => {
  await withSession(
    async (harness) => {
      const { faux, session } = harness
      await selectVirtual(harness, "auto")
      faux.setResponses([failing(QUOTA), fauxAssistantMessage("Continued")])
      await session.prompt("Quota")
      expect(outcomes(session)).toEqual([
        ["standard", "error"],
        ["standard-b", "stop"],
      ])
      expect(continuations(session)).toMatchObject([
        {
          display: false,
          details: {
            tier: "standard",
            restarts: 1,
            tried: [{ providerID: "adaptive-faux", id: "standard" }],
          },
        },
      ])
    },
    { settings: { ...twoStandard, mode: "observe" }, retry: true },
  )
})

it("uses the saved pinned-escalation preference in the real SDK", async () => {
  await withSession(async (harness) => {
    const { faux, session, sources } = harness
    await sources.preferences.update(() => ({
      next: { escalateFromPinned: true },
      result: undefined,
    }))
    await selectVirtual(harness, "quick")
    session.setActiveToolsByName(["adaptive_escalate"])
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("adaptive_escalate", { reason: "too large", evidence: "context overflow" }),
      ]),
      failing(OVERFLOW),
      failing(OVERFLOW),
      fauxAssistantMessage("Recovered"),
    ])
    await session.prompt("Pinned task with opt-in")
    expect(outcomes(session)).toEqual([
      ["quick", "stop"],
      ["quick", "error"],
      ["standard", "error"],
      ["advanced", "stop"],
    ])
    expect(session.model?.id).toBe("quick")
    expect(
      session.agent.state.messages.find((message) => message.role === "toolResult"),
    ).toMatchObject({
      details: { reason: "too large", evidence: "context overflow" },
    })
    faux.setResponses([fauxAssistantMessage("New task")])
    await session.prompt("Fresh pinned task")
    expect(outcomes(session).at(-1)).toEqual(["quick", "stop"])
  })
})

it("restarts a task at most twice", async () => {
  await withSession(
    async (harness) => {
      const { faux, session } = harness
      await selectVirtual(harness, "auto")
      faux.setResponses([
        failing(OUTAGE),
        failing(OUTAGE),
        failing(OUTAGE),
        fauxAssistantMessage("never reached"),
      ])
      await session.prompt("Flaky")
      expect(outcomes(session)).toEqual([
        ["standard", "error"],
        ["standard-b", "error"],
        ["standard", "error"],
      ])
      expect(continuations(session)).toHaveLength(2)
      expect(faux.state.callCount).toBe(3)
    },
    { settings: twoStandard },
  )
})

it("waits in the owned route when every model is briefly limited, then dispatches once", async () => {
  await withSession(
    async (harness) => {
      const { faux, session } = harness
      await selectVirtual(harness, "auto")
      faux.setResponses([
        failing(RATE_LIMITED),
        failing(RATE_LIMITED),
        fauxAssistantMessage("Recovered after reset"),
      ])
      await session.prompt("Everything limited")
      expect(faux.state.callCount).toBe(3)
      expect(outcomes(session)).toEqual([
        ["standard", "error"],
        ["standard-b", "error"],
        ["standard", "stop"],
      ])
      expect(harness.waits.reduce((sum, delay) => sum + delay, 0)).toBe(31_000)
      expect(continuations(session)).toEqual([])
    },
    { settings: twoStandard, retry: true },
  )
})

it("never redirects or restarts a permanent auth failure", async () => {
  await withSession(
    async (harness) => {
      const { faux, session } = harness
      await selectVirtual(harness, "auto")
      faux.setResponses([failing(AUTH), fauxAssistantMessage("never reached")])
      await session.prompt("Bad key")
      expect(outcomes(session)).toEqual([["standard", "error"]])
      expect(faux.state.callCount).toBe(1)
      expect(continuations(session)).toEqual([])
    },
    { settings: twoStandard, retry: true },
  )
})

it("never restarts a run the user aborted", async () => {
  await withSession(
    async (harness) => {
      const { faux, session } = harness
      await selectVirtual(harness, "auto")
      faux.setResponses([
        async (_context, options) => {
          void session.abort()
          await new Promise<void>((resolve) => {
            if (options?.signal?.aborted === true) resolve()
            else
              options?.signal?.addEventListener("abort", () => {
                resolve()
              })
          })
          return fauxAssistantMessage("cut off")
        },
        fauxAssistantMessage("never reached"),
      ])
      await session.prompt("Cancel me")
      await session.waitForIdle()
      expect(outcomes(session)).toEqual([["standard", "aborted"]])
      expect(faux.state.callCount).toBe(1)
      expect(continuations(session)).toEqual([])
    },
    { settings: twoStandard, retry: true },
  )
})

it("parks before dispatch in an owned headless input handler and submits the input exactly once", async () => {
  await withSession(async (harness) => {
    const { session, faux, sources } = harness
    await selectVirtual(harness, "auto")
    await withHealth(sources.health, (registry) => {
      registry.observe({
        kind: "failure",
        key: { providerID: "adaptive-faux", modelID: "standard" },
        category: "quota_exhausted",
        definitive: true,
        retryAfterMs: 180_000,
      })
    })
    faux.setResponses([fauxAssistantMessage("Woke safely")])
    await session.prompt("Never dispatched before the reset")
    await session.waitForIdle()
    expect(faux.state.callCount).toBe(1)
    expect(session.agent.state.messages.filter((message) => message.role === "user")).toHaveLength(
      1,
    )
    expect(assistants(session).at(-1)?.stopReason).toBe("stop")
    expect(harness.waits.reduce((sum, delay) => sum + delay, 0)).toBe(181_000)
    expect(
      JSON.parse(await readFile(join(harness.cwd, "adaptive", "parked.json"), "utf8")),
    ).toMatchObject({ records: [{ claimed: true, wakes: 1 }] })
    expect(continuations(session)).toHaveLength(0)
  })
})

it("parks after durable tool work and resumes through one hidden continuation, not the original input", async () => {
  await withSession(async (harness) => {
    const { session, faux } = harness
    await selectVirtual(harness, "auto")
    session.setActiveToolsByName(["adaptive_test_probe"])
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("adaptive_test_probe", {})]),
      failing(QUOTA),
      fauxAssistantMessage("Continued after the reset"),
    ])
    await session.prompt("Use the durable local probe once")
    expect(harness.probeCalls).toEqual(["probe"])
    expect(faux.state.callCount).toBe(3)
    expect(session.agent.state.messages.filter((message) => message.role === "user")).toHaveLength(
      1,
    )
    expect(continuations(session)).toHaveLength(1)
    expect(continuations(session)[0]).toMatchObject({ display: false })
    expect(assistants(session).at(-1)?.stopReason).toBe("stop")
    expect(harness.waits.reduce((sum, delay) => sum + delay, 0)).toBe(901_000)
    expect(
      JSON.parse(await readFile(join(harness.cwd, "adaptive", "parked.json"), "utf8")),
    ).toMatchObject({ records: [{ claimed: true, wakes: 1 }] })
  })
})

it("aborts an owned route countdown without dispatching or restarting", async () => {
  await withSession(async (harness) => {
    const { session, faux, sources } = harness
    await selectVirtual(harness, "auto")
    await withHealth(sources.health, (registry) => {
      registry.observe({
        kind: "failure",
        key: { providerID: "adaptive-faux", modelID: "standard" },
        category: "rate_limited",
        definitive: true,
        retryAfterMs: 10_000,
      })
    })
    harness.setOnWait(() => {
      void session.abort()
    })
    faux.setResponses([fauxAssistantMessage("never dispatched")])
    await session.prompt("Cancel the countdown")
    await session.waitForIdle()
    expect(faux.state.callCount).toBe(0)
    expect(continuations(session)).toEqual([])
    expect(assistants(session).at(-1)?.stopReason).toBe("aborted")
  })
})

it("attributes passive Codex headers to the dispatched physical provider, never adaptive", async () => {
  await withSession(
    async (harness) => {
      const { session, faux, runtime } = harness
      await selectVirtual(harness, "auto")
      const physical = runtime.getModel("adaptive-faux", "standard")
      if (physical === undefined) throw new Error("model missing")
      faux.setResponses([
        async (_context, options) => {
          await options?.onResponse?.(
            {
              status: 200,
              headers: {
                "x-codex-primary-used-percent": "45",
                "x-codex-primary-reset-after-seconds": "60",
              },
            },
            physical,
          )
          return fauxAssistantMessage("Observed")
        },
      ])
      await session.prompt("Capture passive capacity")
      expect(
        JSON.parse(await readFile(join(harness.cwd, "adaptive", "capacity.json"), "utf8")),
      ).toMatchObject({
        readings: [{ key: { providerID: "adaptive-faux" }, reading: { usedRatio: 0.45 } }],
      })
      // Another instance serving /adaptive status reads the same mirror.
      await session.prompt("/adaptive status")
      expect(harness.shown.join("\n---\n")).toMatch(
        /adaptive-faux\/standard\nstandard · healthy\n {2}used 45%\n {2}resets \d{4}-\d\d-\d\d \d\d:\d\d/,
      )
    },
    { dialogs: { select: () => undefined, confirm: () => Promise.resolve(false) } },
  )
})

/** The RPC-style dialogs of a user who answers by choice title, never by position. */
function answering(
  choices: Record<string, string>,
  confirmed = true,
  onConfirm?: (saved: unknown) => void,
): Dialogs {
  return {
    select: (title, options) => {
      const wanted = Object.entries(choices).find(([prefix]) => title.startsWith(prefix))?.[1]
      return options.find((option) => wanted !== undefined && option.includes(wanted))
    },
    confirm: async (_title, _message, harness) => {
      onConfirm?.(await harness.settingsFile.read())
      return confirmed
    },
  }
}

async function receipts(harness: Harness): Promise<unknown> {
  return JSON.parse(await readFile(join(harness.cwd, "adaptive", "receipts.json"), "utf8"))
}

const unconfigured = { ...defaultSettings(), inviteDismissed: false }

it("offers the first-run proposal once, saving tiers and Observe only after confirmation", async () => {
  let atConfirmation: unknown
  await withSession(
    async (harness) => {
      expect(harness.shown[0]).toContain("Adaptive is installed")
      expect(harness.shown[0]).toContain("standard: adaptive-faux/")
      // Nothing is saved while the user is still deciding.
      expect(atConfirmation).toEqual(unconfigured)
      const saved = await readSettings(harness.settingsFile)
      expect(saved).toMatchObject({ mode: "observe", inviteDismissed: true })
      expect(saved.tiers.standard.length).toBeGreaterThan(0)
      // A reload starts the session again; a dismissed invitation never repeats.
      const offers = harness.shown.filter((text) => text.startsWith("Adaptive is installed"))
      await harness.session.reload()
      expect(harness.shown.filter((text) => text.startsWith("Adaptive is installed"))).toEqual(
        offers,
      )
    },
    {
      settings: unconfigured,
      dialogs: answering({ "Adaptive is installed": "keep my current model" }, true, (saved) => {
        atConfirmation = saved
      }),
    },
  )
})

it("recovers a quota failure with the actual onboarding defaults", async () => {
  await withSession(
    async (harness) => {
      expect(await readSettings(harness.settingsFile)).toMatchObject({
        mode: "observe",
        inviteDismissed: true,
      })
      await selectVirtual(harness, "auto")
      harness.faux.setResponses([
        failing(QUOTA),
        fauxAssistantMessage("Recovered after onboarding"),
      ])
      await harness.session.prompt("First routed task")
      expect(outcomes(harness.session).map(([, stopReason]) => stopReason)).toEqual([
        "error",
        "stop",
      ])
      expect(continuations(harness.session)).toHaveLength(1)
      expect(harness.session.model?.provider).toBe("adaptive")
    },
    {
      settings: unconfigured,
      dialogs: answering({ "Adaptive is installed": "keep my current model" }),
    },
  )
})

it.each(["observe", "off"] as const)(
  "never recovers physical-model failures under global %s even with pinned escalation enabled",
  async (mode) => {
    await withSession(
      async (harness) => {
        await harness.sources.preferences.update(() => ({
          next: { escalateFromPinned: true },
          result: undefined,
        }))
        for (const error of [QUOTA, OVERFLOW]) {
          harness.faux.setResponses([failing(error), fauxAssistantMessage("never reached")])
          await harness.session.prompt("Manual task")
          expect(outcomes(harness.session).at(-1)).toEqual(["standard", "error"])
          expect(continuations(harness.session)).toHaveLength(0)
        }
        expect(harness.faux.state.callCount).toBe(2)
        expect(harness.session.model?.provider).toBe("adaptive-faux")
      },
      { settings: { ...twoStandard, mode } },
    )
  },
)

it("saves nothing but the dismissal when the user declines the first-run proposal", async () => {
  await withSession(
    async (harness) => {
      expect(harness.shown.filter((text) => text.startsWith("Adaptive is installed"))).toHaveLength(
        1,
      )
      expect(await readSettings(harness.settingsFile)).toMatchObject({
        mode: "observe",
        inviteDismissed: true,
        tiers: { quick: [], standard: [], advanced: [] },
      })
    },
    { settings: unconfigured, dialogs: answering({ "Adaptive is installed": "Not now" }) },
  )
})

const dismissed = (patch: Partial<SettingsV1>): SettingsV1 => ({ ...settings, ...patch })
const preferB = {
  ...settings.tiers,
  standard: [
    { providerID: "adaptive-faux", id: "standard-b" },
    { providerID: "adaptive-faux", id: "standard" },
  ],
}
const acknowledging = answering({ "": "Back" })

it("observes a manual model with a receipt and an 'Observing · would' note, then explains it", async () => {
  await withSession(
    async (harness) => {
      const { faux, session } = harness
      faux.setResponses([fauxAssistantMessage("Manual answer")])
      await session.prompt("Manual task")
      expect(assistants(session).map((message) => message.model)).toEqual(["standard"])
      expect(session.model?.id).toBe("standard")
      expect(await receipts(harness)).toMatchObject({
        receipts: [
          {
            tier: "standard",
            decision: {
              kind: "observe-only",
              would: { kind: "apply", model: { id: "standard-b" } },
            },
          },
        ],
      })
      expect(
        session.sessionManager
          .getBranch()
          .filter((entry) => entry.type === "custom" && entry.customType === "adaptive.note"),
      ).toMatchObject([{ data: { text: "Observing · would standard → adaptive-faux/standard-b" } }])
      await session.prompt("/adaptive why")
      expect(harness.shown.at(-1)).toContain("Latest decision")
      expect(harness.shown.at(-1)).toContain("Adaptive is observing")
      // Observe and active share one scheduler: a virtual selection picks what was predicted.
      await selectVirtual(harness, "auto")
      faux.setResponses([fauxAssistantMessage("Routed answer")])
      await session.prompt("Routed task")
      expect(assistants(session).at(-1)?.model).toBe("standard-b")
    },
    { settings: dismissed({ mode: "observe", tiers: preferB }), dialogs: acknowledging },
  )
})

it("records and changes nothing for a manual model while Adaptive is off", async () => {
  await withSession(
    async (harness) => {
      const { faux, session } = harness
      faux.setResponses([fauxAssistantMessage("Manual answer")])
      await session.prompt("Manual task")
      expect(assistants(session).map((message) => message.model)).toEqual(["standard"])
      expect(session.sessionManager.getBranch().filter((entry) => entry.type === "custom")).toEqual(
        [],
      )
      await expect(
        readFile(join(harness.cwd, "adaptive", "receipts.json"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" })
      await expect(
        readFile(join(harness.cwd, "adaptive", "health.json"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" })
    },
    { settings: dismissed({ mode: "off", tiers: preferB }) },
  )
})

it("falls back to the tier's first compatible model when the pin cannot be verified", async () => {
  await withSession(
    async (harness) => {
      const { faux, session } = harness
      await selectVirtual(harness, "auto")
      faux.setResponses([fauxAssistantMessage("Ordinary routing")])
      await session.prompt("Pinned to a model Pi does not have")
      expect(outcomes(session)).toEqual([["standard-b", "stop"]])
      expect(await receipts(harness)).toMatchObject({
        receipts: [{ decision: { kind: "defer", reason: "pin-unverifiable" } }],
      })
    },
    {
      settings: dismissed({ tiers: preferB, pin: { providerID: "adaptive-faux", id: "ghost" } }),
    },
  )
})

it("refuses to guess a model when the virtual entry has no tier to fall back to", async () => {
  await withSession(
    async (harness) => {
      const { faux, session } = harness
      await selectVirtual(harness, "auto")
      faux.setResponses([fauxAssistantMessage("never reached")])
      await session.prompt("Nothing is configured")
      const [failure] = assistants(session)
      expect(failure?.stopReason).toBe("error")
      expect(failure?.errorMessage).toContain("Adaptive is not set up")
      expect(faux.state.callCount).toBe(0)
    },
    {
      settings: dismissed({
        tiers: { quick: [], standard: [], advanced: [] },
        pin: { providerID: "adaptive-faux", id: "ghost" },
      }),
    },
  )
})

it("reports setup problems with a remedy in /adaptive doctor", async () => {
  await withSession(
    async (harness) => {
      await harness.session.prompt("/adaptive doctor")
      const report = harness.shown.at(-1) ?? ""
      expect(report).toContain("Adaptive doctor")
      expect(report).toContain(`OK Pi ${VERSION} (supported: ≥1.5.0 <2)`)
      expect(report).toContain("OK All four Adaptive models registered")
      expect(report).toContain("OK Credentials configured for")
      expect(report).toContain("FIX adaptive-faux/ghost (advanced): model missing")
      expect(report).toContain("Refresh Pi's model catalog or remove this tier entry.")
      expect(report).toContain("OK Shared storage writable")
    },
    {
      settings: dismissed({
        tiers: { ...settings.tiers, advanced: [{ providerID: "adaptive-faux", id: "ghost" }] },
      }),
      dialogs: acknowledging,
    },
  )
})
