// covers: ["ADP-019", "ADP-059"]
import assert from "node:assert/strict"
import { join } from "node:path"
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent"
import { fauxProvider } from "@earendil-works/pi-ai"

const cwd = process.cwd()
const agentDir = process.env["PI_CODING_AGENT_DIR"]
const extension = process.env["PI_MATRIX_EXTENSION"]
const worker = process.env["PI_MATRIX_WORKER"]
assert.ok(agentDir && extension && worker)
const runtime = await ModelRuntime.create({
  authPath: join(cwd, `probe-auth-${worker}.json`),
  modelsPath: null,
  modelsStorePath: join(cwd, `probe-models-${worker}.json`),
  refreshOnCreate: false,
})
const faux = fauxProvider({ provider: "adaptive-faux", models: [{ id: "quick" }] })
runtime.registerNativeProvider(faux.provider)
await runtime.setRuntimeApiKey("adaptive-faux", "local-faux-test-data")
await runtime.refresh()
const loader = new DefaultResourceLoader({
  cwd,
  agentDir,
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  additionalExtensionPaths: [extension],
})
await loader.reload()
const { session } = await createAgentSession({
  cwd,
  agentDir,
  modelRuntime: runtime,
  model: faux.getModel(),
  resourceLoader: loader,
  sessionManager: SessionManager.inMemory(cwd),
  settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
})
try {
  await session.bindExtensions({})
  session.setActiveToolsByName([])
  const auto = runtime.getModel("adaptive", "auto")
  assert.ok(auto)
  try {
    const route = await runtime.resolveModel(
      auto,
      [{ role: "user", content: "One cross-process probe", timestamp: Date.now() }],
      { reason: "direct", thinkingLevel: "off" },
    )
    assert.equal(route.model.id, "quick")
    console.log("MATRIX_PROBE_ADMITTED")
    // No response is submitted: a concurrent process must see this probe in flight.
  } catch (error) {
    assert.ok(
      error instanceof Error && error.message.includes("Adaptive unavailable"),
      String(error),
    )
    console.log("MATRIX_PROBE_REJECTED")
  }
} finally {
  session.dispose()
}
