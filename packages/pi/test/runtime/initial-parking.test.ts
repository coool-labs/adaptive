// covers: ["ADP-024", "ADP-060", "ADP-058"]
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  VERSION,
  type AgentSession,
} from "@earendil-works/pi-coding-agent"
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux"
import { defaultSettings } from "@coool/adaptive-core/state/settings/parse"
import { registerAdaptive, type AdaptiveSources } from "../../src/host/extension.js"
import { withHealth } from "../../src/health.js"
import { findPark } from "../../src/parking.js"
import { jsonFile } from "../../src/store.js"
import { NOTE_ENTRY } from "../../src/host/entries.js"

async function withParkedSession(
  run: (harness: {
    readonly file: string
    readonly sources: AdaptiveSources
    readonly faux: ReturnType<typeof fauxProvider>
    readonly confirm: ReturnType<typeof vi.fn<() => Promise<boolean>>>
    open(waitForWake?: boolean): Promise<AgentSession>
    close(session: AgentSession): Promise<void>
    advanceToDue(): Promise<void>
    fire(): void
  }) => Promise<void>,
): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), "adaptive-initial-park-"))
  try {
    const runtime = await ModelRuntime.create({
      authPath: join(cwd, "auth.json"),
      modelsPath: null,
      modelsStorePath: join(cwd, "models.json"),
      refreshOnCreate: false,
    })
    const faux = fauxProvider({ provider: "initial-park-faux", models: [{ id: "local" }] })
    runtime.registerNativeProvider(faux.provider)
    await runtime.setRuntimeApiKey("initial-park-faux", "local-faux-test-data")
    await runtime.refresh()
    let now = 1_000
    let id = 0
    const timers = new Set<() => void>()
    const confirm = vi.fn(() => Promise.resolve(true))
    const sources: AdaptiveSources = {
      settings: () =>
        Promise.resolve({
          ...defaultSettings(),
          mode: "active",
          inviteDismissed: true,
          tiers: {
            quick: [],
            standard: [{ providerID: "initial-park-faux", id: "local" }],
            advanced: [],
          },
        }),
      capabilities: () =>
        Promise.resolve([{ providerID: "initial-park-faux", id: "local", tools: true }]),
      newId: () => String(++id),
      health: { file: jsonFile(join(cwd, "health.json")), clock: () => now, newId: () => "probe" },
      capacity: { file: jsonFile(join(cwd, "capacity.json")), clock: () => now },
      parking: {
        file: jsonFile(join(cwd, "parked.json")),
        clock: () => now,
        timer: (callback) => {
          timers.add(callback)
          return () => {
            timers.delete(callback)
          }
        },
      },
      receipts: jsonFile(join(cwd, "receipts.json")),
      preferences: jsonFile(join(cwd, "preferences.json")),
    }
    await withHealth(sources.health, (health) =>
      health.observe({
        kind: "failure",
        key: { providerID: "initial-park-faux", modelID: "local" },
        category: "quota_exhausted",
        definitive: true,
        retryAfterMs: 900_000,
      }),
    )
    const settings = await sources.settings()
    await jsonFile(join(cwd, "settings.json")).update(() => ({ next: settings, result: undefined }))
    const close = async (session: AgentSession) => {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" })
      session.dispose()
    }
    const open = async (manager: SessionManager, waitForWake = false) => {
      const loader = new DefaultResourceLoader({
        cwd,
        agentDir: cwd,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        extensionFactories: [
          (pi) => {
            registerAdaptive(pi, sources, {
              settings: jsonFile(join(cwd, "settings.json")),
              version: VERSION,
              minimum: "1.5.0",
              testedUpTo: undefined,
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
        sessionManager: manager,
        settingsManager: SettingsManager.inMemory({
          compaction: { enabled: false },
          retry: { enabled: false },
        }),
      })
      const virtual = runtime.getModel("adaptive", "auto")
      if (virtual === undefined) throw new Error("virtual model missing")
      await session.setModel(virtual)
      session.setActiveToolsByName([])
      const settled = waitForWake ? nextSettle(session) : undefined
      await session.bindExtensions({
        mode: "tui",
        uiContext: { ...session.extensionRunner.getUIContext(), confirm },
      })
      session.setActiveToolsByName([])
      await settled
      return session
    }
    const manager = SessionManager.create(cwd, join(cwd, "sessions"))
    const session = await open(manager)
    try {
      await session.prompt("PRIVATE_INITIAL_PARKED_PROMPT")
      expect(faux.state.callCount).toBe(0)
      expect(await findPark(sources.parking.file, manager.getSessionId())).toBeDefined()
    } finally {
      await close(session)
    }
    const file = manager.getSessionFile()
    expect(file).toBeDefined()
    if (file === undefined) throw new Error("session path missing")
    expect(existsSync(file), "initial parked Pi session must exist after close").toBe(true)
    expect(await readFile(file, "utf8")).toContain("PRIVATE_INITIAL_PARKED_PROMPT")
    expect(SessionManager.open(file).getSessionId()).toBe(manager.getSessionId())
    expect(JSON.stringify(await sources.parking.file.read())).not.toContain(
      "PRIVATE_INITIAL_PARKED_PROMPT",
    )
    await run({
      file,
      sources,
      faux,
      confirm,
      open: (waitForWake) => open(SessionManager.open(file), waitForWake),
      close,
      advanceToDue: async () => {
        const record = await findPark(sources.parking.file, manager.getSessionId())
        if (record === undefined) throw new Error("park missing")
        now = record.due
      },
      fire: () => {
        const ready = [...timers]
        timers.clear()
        for (const callback of ready) callback()
      },
    })
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}

function nextSettle(session: AgentSession): Promise<void> {
  return new Promise((resolve) => {
    const unsubscribe = session.subscribe((event) => {
      if (event.type !== "agent_settled") return
      unsubscribe()
      resolve()
    })
  })
}

function userPrompts(manager: SessionManager): unknown[] {
  return manager
    .getEntries()
    .filter((entry) => entry.type === "message" && entry.message.role === "user")
}

it("closes and reopens an initial park before its deadline, then wakes once without replaying the prompt", async () => {
  await withParkedSession(async (h) => {
    const session = await h.open()
    try {
      expect(h.confirm).not.toHaveBeenCalled()
      expect(h.faux.state.callCount).toBe(0)
      expect(userPrompts(session.sessionManager)).toHaveLength(1)
      const requests: string[] = []
      h.faux.setResponses([
        (context) => {
          requests.push(JSON.stringify(context.messages))
          return fauxAssistantMessage("RESUMED", { timestamp: 0 })
        },
      ])
      await h.advanceToDue()
      const settled = nextSettle(session)
      h.fire()
      await settled
      h.fire()
      expect(h.faux.state.callCount).toBe(1)
      expect(
        session.sessionManager
          .getEntries()
          .flatMap((entry) =>
            entry.type === "custom" && entry.customType === NOTE_ENTRY ? [entry.data] : [],
          ),
      ).toContainEqual({
        version: 1,
        text: "standard resumed · retrying parked work",
      })
      expect(requests).toHaveLength(1)
      expect(requests[0]).not.toContain("standard resumed · retrying parked work")
      expect(
        JSON.stringify(session.sessionManager.buildSessionProjection().messages),
      ).not.toContain("standard resumed · retrying parked work")
      expect(userPrompts(session.sessionManager)).toHaveLength(1)
      expect(
        session.sessionManager
          .getEntries()
          .filter(
            (entry) =>
              entry.type === "custom_message" && entry.customType === "adaptive.continuation",
          ),
      ).toHaveLength(1)
      expect(
        await findPark(h.sources.parking.file, session.sessionManager.getSessionId()),
      ).toBeUndefined()
      h.faux.setResponses([
        (context) => {
          requests.push(JSON.stringify(context.messages))
          return fauxAssistantMessage("FOLLOWUP", { timestamp: 0 })
        },
      ])
      await session.prompt("FOLLOWUP_AFTER_RESUMED_NOTE")
      expect(requests).toHaveLength(2)
      expect(requests[1]).not.toContain("standard resumed · retrying parked work")
    } finally {
      await h.close(session)
    }
  })
})

it.each([true, false])(
  "asks after an initial park becomes due and honours consent=%s",
  async (accept) => {
    await withParkedSession(async (h) => {
      await h.advanceToDue()
      h.confirm.mockResolvedValue(accept)
      h.faux.setResponses([fauxAssistantMessage("RESUMED", { timestamp: 0 })])
      const session = await h.open(accept)
      try {
        expect(h.confirm).toHaveBeenCalledExactlyOnceWith(
          "Parked task",
          "Resume the parked task now?",
          undefined,
        )
        h.fire()
        expect(h.faux.state.callCount).toBe(accept ? 1 : 0)
        expect(userPrompts(session.sessionManager)).toHaveLength(1)
        expect(
          await findPark(h.sources.parking.file, session.sessionManager.getSessionId()),
        ).toBeUndefined()
      } finally {
        await h.close(session)
      }
      const reopened = await h.open()
      try {
        expect(h.confirm).toHaveBeenCalledTimes(1)
        expect(h.faux.state.callCount).toBe(accept ? 1 : 0)
      } finally {
        await h.close(reopened)
      }
    })
  },
)

it.each(["cancel", "physical"])(
  "%s cancels an initially parked session after reopen",
  async (action) => {
    await withParkedSession(async (h) => {
      const session = await h.open()
      try {
        if (action === "cancel") await session.prompt("/adaptive cancel")
        else await session.setModel(h.faux.models[0])
        h.fire()
        expect(
          await findPark(h.sources.parking.file, session.sessionManager.getSessionId()),
        ).toBeUndefined()
        expect(h.faux.state.callCount).toBe(0)
      } finally {
        await h.close(session)
      }
    })
  },
)
