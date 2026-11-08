// covers: ["ADP-057", "ADP-064"]
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
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

it("loads the real extension binding and dispatches every virtual entry through Pi 1.5", async () => {
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
      models: [{ id: "quick" }, { id: "standard" }, { id: "advanced" }],
    })
    runtime.registerNativeProvider(faux.provider)
    await runtime.setRuntimeApiKey("adaptive-faux", "local-faux-test-data")
    await runtime.refresh()
    const settings = {
      ...defaultSettings(),
      mode: "active" as const,
      tiers: {
        quick: [{ providerID: "adaptive-faux", id: "quick" }],
        standard: [{ providerID: "adaptive-faux", id: "standard" }],
        advanced: [{ providerID: "adaptive-faux", id: "advanced" }],
      },
    }
    let admissions = 0
    const toolCalls: string[] = []
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: cwd,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      extensionFactories: [
        (pi) => {
          registerAdaptive(
            pi,
            () => {
              admissions += 1
              return Promise.resolve(settings)
            },
            () =>
              Promise.resolve(
                faux.models.map((model) => ({
                  providerID: model.provider,
                  id: model.id,
                  tools: true,
                })),
              ),
          )
          pi.registerTool({
            name: "adaptive_test_probe",
            label: "Probe",
            description: "Deterministic local tool fixture",
            parameters: { type: "object", properties: {}, additionalProperties: false },
            execute: () => {
              toolCalls.push("probe")
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
        retry: { enabled: false },
      }),
    })
    try {
      await session.bindExtensions({})
      session.setActiveToolsByName([])
      for (const id of ["auto", "quick", "standard", "advanced"]) {
        const virtual = runtime.getModel("adaptive", id)
        expect(virtual, id).toBeDefined()
        if (virtual === undefined) throw new Error(`missing virtual ${id}`)
        await session.setModel(virtual)
        faux.setResponses([fauxAssistantMessage(`Answered ${id}`)])
        await session.prompt("Test routing")
        const assistant = session.agent.state.messages
          .filter((message) => message.role === "assistant")
          .at(-1)
        expect(assistant?.model).toBe(id === "auto" ? "standard" : id)
        expect(assistant?.stopReason).toBe("stop")
      }
      await session.setModel(physical)
      faux.setResponses([fauxAssistantMessage("Manual choice")])
      await session.prompt("Manual model")
      expect(
        session.agent.state.messages.filter((message) => message.role === "assistant").at(-1)
          ?.model,
      ).toBe("standard")
      expect(faux.state.callCount).toBe(5)
      expect(admissions).toBe(4)
      const virtual = runtime.getModel("adaptive", "auto")
      if (virtual === undefined) throw new Error("missing virtual auto")
      await session.setModel(virtual)
      session.setActiveToolsByName(["adaptive_test_probe"])
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("adaptive_test_probe", {})]),
        fauxAssistantMessage("Tool continuation complete"),
      ])
      await session.prompt("Call the local probe")
      expect(toolCalls).toEqual(["probe"])
      expect(faux.state.callCount).toBe(7)
      expect(admissions).toBe(6)
      const toolRun = session.agent.state.messages
        .filter((message) => message.role === "assistant")
        .slice(-2)
      expect(toolRun.map((message) => message.model)).toEqual(["standard", "standard"])
      expect(toolRun.at(-1)?.stopReason).toBe("stop")
    } finally {
      session.dispose()
    }
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
