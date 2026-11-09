// covers: ["ADP-010", "ADP-011", "ADP-013", "ADP-014", "ADP-022", "ADP-057", "ADP-059", "ADP-061", "ADP-064"]
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import type { AgentSession } from "@earendil-works/pi-coding-agent"
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent"
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux"
import { defaultSettings } from "@coool/adaptive-core/state/settings/parse"
import { registerAdaptive } from "../../src/host/extension.js"
import { jsonFile } from "../../src/store.js"

interface Harness {
  readonly cwd: string
  readonly runtime: ModelRuntime
  readonly faux: ReturnType<typeof fauxProvider>
  readonly session: AgentSession
  readonly settingsReads: () => number
  readonly probeCalls: readonly string[]
}

const settings = {
  ...defaultSettings(),
  mode: "active" as const,
  tiers: {
    quick: [{ providerID: "adaptive-faux", id: "quick" }],
    standard: [{ providerID: "adaptive-faux", id: "standard" }],
    advanced: [{ providerID: "adaptive-faux", id: "advanced" }],
  },
}

interface SessionOptions {
  readonly settings?: typeof settings
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
    const probeCalls: string[] = []
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: cwd,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      extensionFactories: [
        (pi) => {
          registerAdaptive(pi, {
            settings: () => {
              settingsReads += 1
              return Promise.resolve(routed)
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
              clock: Date.now,
              newId: () => {
                ids += 1
                return `probe-${String(ids)}`
              },
            },
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
      await session.bindExtensions({})
      session.setActiveToolsByName([])
      await run({ cwd, runtime, faux, session, settingsReads: () => settingsReads, probeCalls })
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
    // One read per route, per routed response and per settled Adaptive run; the
    // manual run reads none.
    expect(harness.settingsReads()).toBe(12)
    await selectVirtual(harness, "auto")
    session.setActiveToolsByName(["adaptive_test_probe"])
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("adaptive_test_probe", {})]),
      fauxAssistantMessage("Tool continuation complete"),
    ])
    await session.prompt("Call the local probe")
    expect(harness.probeCalls).toEqual(["probe"])
    expect(faux.state.callCount).toBe(7)
    expect(harness.settingsReads()).toBe(17)
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
    { settings: twoStandard, retry: true },
  )
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

it("ends with a clear error and no loop when every model of the tier is down", async () => {
  await withSession(
    async (harness) => {
      const { faux, session } = harness
      await selectVirtual(harness, "auto")
      faux.setResponses([
        failing(RATE_LIMITED),
        failing(RATE_LIMITED),
        fauxAssistantMessage("never reached"),
      ])
      await session.prompt("Everything limited")
      expect(faux.state.callCount).toBe(2)
      expect(outcomes(session)).toEqual([
        ["standard", "error"],
        ["standard-b", "error"],
        ["auto", "error"],
      ])
      expect(assistants(session).at(-1)).toMatchObject({
        provider: "adaptive",
        errorMessage: "Adaptive unavailable: all-blocked. Check your tier settings.",
      })
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
