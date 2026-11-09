import { appendFileSync } from "node:fs"
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

/** This fixture registers physical models only; Adaptive must supply every router. */
export default function fauxExtension(pi: ExtensionAPI): void {
  const faux = createFauxCore({
    provider: "adaptive-faux",
    models: ["quick", "standard", "standard-b", "advanced", "manual-physical"].map((id) => ({
      id,
    })),
  })
  const scenario = process.env["PI_MATRIX_SCENARIO"] ?? "success"
  const errors: Record<string, string> = {
    "503": "503 Service Unavailable",
    "429": "429 Too Many Requests. Retry after 60 seconds.",
    quota: "You exceeded your current quota, please check your plan and billing details.",
    auth: "401 Invalid API key",
  }
  const failure = errors[scenario]
  faux.setResponses([
    ...(scenario === "durable-park"
      ? [
          fauxAssistantMessage([fauxToolCall("matrix_probe", {})]),
          fauxAssistantMessage("", {
            stopReason: "error",
            errorMessage: errors["quota"] ?? "quota exhausted",
          }),
        ]
      : []),
    ...(failure === undefined
      ? []
      : [fauxAssistantMessage("", { stopReason: "error", errorMessage: failure })]),
    ...Array.from(
      { length: 16 },
      () => (_context: unknown, _options: unknown, _state: unknown, model: { id: string }) =>
        fauxAssistantMessage(`MATRIX_OK ${model.id}`),
    ),
  ])
  const trace = process.env["PI_MATRIX_TRACE"]
  if (trace === undefined) throw new Error("PI_MATRIX_TRACE is required")
  const log = (event: Record<string, unknown>): void => {
    appendFileSync(trace, `${JSON.stringify({ ...event, at: Date.now() })}\n`)
  }
  pi.on("session_start", (_event, ctx) => {
    log({
      kind: "session",
      file: ctx.sessionManager.getSessionFile(),
      session: ctx.sessionManager.getSessionId(),
    })
    // A real catalog model this isolated host has no credentials for, for the doctor journey.
    const keyless = ctx.modelRegistry
      .getAll()
      .find(
        (model) =>
          !(model.provider.startsWith("adaptive") || ctx.modelRegistry.hasConfiguredAuth(model)),
      )
    if (keyless !== undefined)
      log({ kind: "keyless", provider: keyless.provider, model: keyless.id })
  })
  pi.on("agent_settled", (event) => {
    log({ kind: "settled", aborted: event.aborted })
  })
  pi.registerTool({
    name: "matrix_probe",
    label: "Matrix durable probe",
    description: "One durable, local matrix side effect",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: () => {
      log({ kind: "probe" })
      return Promise.resolve({ content: [{ type: "text", text: "MATRIX_PROBE_OK" }], details: {} })
    },
  })
  if (process.env["PI_MATRIX_HOST_UI"] === "1") {
    pi.on("session_start", (_event, ctx) => {
      ctx.ui.setStatus("matrix-platform", "MATRIX_STATUS host rendering probe")
      ctx.ui.setWidget("matrix-platform", ["MATRIX_WIDGET line one", "MATRIX_WIDGET line two"])
    })
    pi.registerShortcut("ctrl+alt+a", {
      description: "Matrix host key probe (not Adaptive's M6 command)",
      handler: (ctx) => {
        ctx.ui.setStatus("matrix-platform", "MATRIX_SHORTCUT_OK")
        return Promise.resolve()
      },
    })
  }
  pi.registerProvider("adaptive-faux", {
    api: faux.api,
    baseUrl: "http://127.0.0.1:1",
    apiKey: "local-faux-test-data",
    models: faux.models,
    streamSimple(model, context, options) {
      log({ kind: "dispatch", model: model.id, messages: context.messages })
      return faux.streamSimple(model, context, options)
    },
  })
  pi.on("model_select", (event) => {
    appendFileSync(
      trace,
      `${JSON.stringify({ kind: "model", provider: event.model.provider, model: event.model.id, source: event.source })}\n`,
    )
  })
}
