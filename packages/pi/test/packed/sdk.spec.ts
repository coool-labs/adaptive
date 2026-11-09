// covers: ["ADP-001", "ADP-002", "ADP-005", "ADP-016", "ADP-017", "ADP-018", "ADP-021", "ADP-027", "ADP-030", "ADP-031", "ADP-051", "ADP-057", "ADP-064"]
import assert from "node:assert/strict"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent"
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai"

const cwd = process.cwd()
const agentDir = process.env["PI_CODING_AGENT_DIR"]
const extension = process.env["PI_MATRIX_EXTENSION"]
assert.ok(agentDir)
assert.ok(extension)
const settingsPath = join(agentDir, "adaptive/settings.json")
const originalSettings = readFileSync(settingsPath, "utf8")
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
const runtime = await ModelRuntime.create({
  authPath: join(cwd, "sdk-auth.json"),
  modelsPath: null,
  modelsStorePath: join(cwd, "sdk-models.json"),
  refreshOnCreate: false,
})
const faux = fauxProvider({
  provider: "adaptive-faux",
  models: [
    ...["quick", "standard", "standard-b", "advanced", "manual-physical"].map((id) => ({ id })),
    { id: "standard-small", contextWindow: 16 },
  ],
})
runtime.registerNativeProvider(faux.provider)
await runtime.setRuntimeApiKey("adaptive-faux", "local-faux-test-data")
await runtime.refresh()
let directDemandCharacters = 0
const resolveModel = runtime.resolveModel.bind(runtime)
runtime.resolveModel = (model, messages, options) => {
  if (options.reason === "direct") directDemandCharacters = JSON.stringify(messages).length
  return resolveModel(model, messages, options)
}
let probes = 0
const loader = new DefaultResourceLoader({
  cwd,
  agentDir,
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  additionalExtensionPaths: [extension],
  extensionFactories: [
    (pi) => {
      pi.registerTool({
        name: "matrix_probe",
        label: "Matrix probe",
        description: "Local durable side effect",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        execute: () => {
          probes += 1
          return Promise.resolve({ content: [{ type: "text", text: "PROBE_OK" }], details: {} })
        },
      })
    },
  ],
})
await loader.reload()
assert.equal(loader.getExtensions().errors.length, 0)
const physical = runtime.getModel("adaptive-faux", "manual-physical")
assert.ok(physical)
const { session } = await createAgentSession({
  cwd,
  agentDir,
  modelRuntime: runtime,
  model: physical,
  resourceLoader: loader,
  sessionManager: SessionManager.inMemory(cwd),
  settingsManager: SettingsManager.inMemory({
    compaction: { enabled: false, keepRecentTokens: 128, reserveTokens: 256 },
    retry: { enabled: true, baseDelayMs: 1, maxRetries: 2 },
  }),
})
const models: string[] = []
session.subscribe((event) => {
  if (event.type === "message_end" && event.message.role === "assistant")
    models.push(event.message.model)
})
try {
  await session.bindExtensions({})
  session.setActiveToolsByName([])
  for (const id of ["auto", "quick", "standard", "advanced"]) {
    const virtual = runtime.getModel("adaptive", id)
    assert.ok(virtual, `missing packed virtual model ${id}`)
    await session.setModel(virtual)
    faux.setResponses([fauxAssistantMessage("MATRIX_OK")])
    await session.prompt("Exercise packed routing")
    assert.equal(models.at(-1), id === "auto" ? "standard" : id)
  }
  const auto = runtime.getModel("adaptive", "auto")
  assert.ok(auto)
  await session.setModel(auto)
  session.setActiveToolsByName(["matrix_probe"])
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("matrix_probe", {})]),
    fauxAssistantMessage("MATRIX_OK"),
  ])
  await session.prompt("Exercise one local side effect")
  assert.equal(probes, 1)
  assert.deepEqual(models.slice(-2), ["standard", "standard"])
  session.setActiveToolsByName([])
  faux.setResponses([fauxAssistantMessage("MATRIX_OK")])
  await session.prompt("Compaction demand ".repeat(1024))
  let summaryModel = ""
  faux.setResponses([
    (_context, _options, _state, model) => {
      summaryModel = model.id
      return fauxAssistantMessage("MATRIX_COMPACTED")
    },
  ])
  const compacted = await session.compact()
  assert.equal(summaryModel, "quick", "actual compaction must use the auxiliary quick tier")
  assert.ok(directDemandCharacters > 16_000, "direct routing did not receive the active context")
  assert.ok(compacted.summary.includes("MATRIX_COMPACTED"))

  const configured: unknown = JSON.parse(originalSettings)
  assert.ok(object(configured) && object(configured["tiers"]))
  writeFileSync(
    settingsPath,
    JSON.stringify({
      ...configured,
      tiers: {
        ...configured["tiers"],
        standard: [
          { providerID: "adaptive-faux", id: "standard-small" },
          { providerID: "adaptive-faux", id: "standard" },
        ],
      },
    }),
  )
  faux.setResponses([fauxAssistantMessage("MATRIX_COMPATIBLE")])
  await session.prompt("Only dispatch a model that fits the active context")
  assert.equal(models.at(-1), "standard", "a preferred but incompatible model was dispatched")
  writeFileSync(settingsPath, originalSettings)

  const capacityPath = join(agentDir, "adaptive/capacity.json")
  const capacity = (usedRatio: number) => ({
    version: 1,
    readings: [
      {
        key: { providerID: "adaptive-faux", modelID: "standard" },
        reading: {
          usedRatio,
          remainingRatio: 1 - usedRatio,
          confidence: "high",
          observedAt: Date.now(),
          resetAt: Date.now() + 60_000,
        },
      },
    ],
  })
  writeFileSync(capacityPath, JSON.stringify(capacity(0.95)))
  faux.setResponses([fauxAssistantMessage("MATRIX_DRAINED")])
  await session.prompt("Do not admit new work to a draining preferred model")
  assert.equal(models.at(-1), "standard-b")
  writeFileSync(capacityPath, JSON.stringify(capacity(0.1)))
  faux.setResponses([fauxAssistantMessage("MATRIX_RECOVERED")])
  await session.prompt("A recovered preferred model returns only at this new safe boundary")
  assert.equal(models.at(-1), "standard")

  const secret = "MATRIX_SECRET_MUST_NOT_LEAK"
  const malformed = JSON.stringify({ version: 999, token: secret })
  writeFileSync(capacityPath, malformed)
  faux.setResponses([
    (context) => {
      assert.ok(
        !JSON.stringify(context).includes(secret),
        "private adapter data entered model context",
      )
      return fauxAssistantMessage("MATRIX_FAIL_OPEN")
    },
  ])
  await session.prompt("An optional capacity failure must fail open without rewriting its file")
  assert.equal(models.at(-1), "standard")
  assert.equal(readFileSync(capacityPath, "utf8"), malformed)
  writeFileSync(capacityPath, JSON.stringify({ version: 1, readings: [] }))

  const receiptsPath = join(agentDir, "adaptive/receipts.json")
  const payload: unknown = JSON.parse(readFileSync(receiptsPath, "utf8"))
  assert.ok(object(payload) && Array.isArray(payload["receipts"]))
  const template: unknown = payload["receipts"].at(-1)
  assert.ok(object(template))
  writeFileSync(
    receiptsPath,
    JSON.stringify({
      version: 1,
      receipts: Array.from({ length: 200 }, (_, index) => ({ ...template, id: index + 1 })),
    }),
  )
  faux.setResponses([fauxAssistantMessage("MATRIX_BOUNDED")])
  await session.prompt("MATRIX_PRIVATE_PROMPT_MUST_NOT_ENTER_RECEIPTS")
  const bounded: unknown = JSON.parse(readFileSync(receiptsPath, "utf8"))
  assert.ok(object(bounded) && Array.isArray(bounded["receipts"]))
  assert.equal(bounded["receipts"].length, 200)
  const oldest: unknown = bounded["receipts"][0]
  const newest: unknown = bounded["receipts"].at(-1)
  assert.ok(object(oldest) && object(newest))
  assert.equal(oldest["id"], 2)
  assert.equal(newest["id"], 201)
  assert.ok(
    !readFileSync(receiptsPath, "utf8").includes("MATRIX_PRIVATE_PROMPT_MUST_NOT_ENTER_RECEIPTS"),
  )
  assert.ok(!readFileSync(receiptsPath, "utf8").includes(secret))
  await session.setModel(physical)
  faux.setResponses([fauxAssistantMessage("MATRIX_OK")])
  await session.prompt("Manual physical takeover")
  assert.equal(models.at(-1), "manual-physical")
  assert.equal(faux.state.callCount, 14)
  console.log(
    JSON.stringify({
      surface: "sdk",
      models,
      probes,
      summaryModel,
      directDemandCharacters,
      result: "PASS",
    }),
  )
} finally {
  writeFileSync(settingsPath, originalSettings)
  session.dispose()
}
