// covers: ["ADP-030", "ADP-052", "ADP-058"]
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
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai"
import { appendNote, registerEntries, NOTE_ENTRY } from "../../src/host/entries.js"

it("keeps rendered transcript notes out of the actual provider request and later SDK context", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "adaptive-note-sdk-"))
  try {
    const runtime = await ModelRuntime.create({
      authPath: join(cwd, "auth.json"),
      modelsPath: null,
      modelsStorePath: join(cwd, "models.json"),
      refreshOnCreate: false,
    })
    const faux = fauxProvider({ provider: "adaptive-note-faux", models: [{ id: "local" }] })
    const received: string[] = []
    faux.setResponses([
      (context) => {
        received.push(JSON.stringify(context.messages))
        return fauxAssistantMessage("DONE", { timestamp: 0 })
      },
      (context) => {
        received.push(JSON.stringify(context.messages))
        return fauxAssistantMessage("AGAIN", { timestamp: 0 })
      },
    ])
    runtime.registerNativeProvider(faux.provider)
    await runtime.setRuntimeApiKey("adaptive-note-faux", "local-faux-test-data")
    await runtime.refresh()
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: cwd,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      extensionFactories: [
        (pi) => {
          registerEntries(pi)
          pi.on("before_agent_start", () => {
            appendNote(pi, { version: 1, text: "NOTE_NEVER_IN_CONTEXT", receiptID: 1 })
          })
        },
      ],
    })
    await loader.reload()
    const { session } = await createAgentSession({
      cwd,
      agentDir: cwd,
      modelRuntime: runtime,
      model: faux.models[0],
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
      await session.prompt("First local request")
      await session.prompt("Second local request")
      expect(received).toHaveLength(2)
      expect(received.join("\n")).not.toContain("NOTE_NEVER_IN_CONTEXT")
      expect(
        session.sessionManager
          .getEntries()
          .filter((entry) => entry.type === "custom" && entry.customType === NOTE_ENTRY),
      ).toHaveLength(2)
      expect(
        JSON.stringify(session.sessionManager.buildSessionProjection().messages),
      ).not.toContain("NOTE_NEVER_IN_CONTEXT")
    } finally {
      session.dispose()
    }
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
