import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai"

export default function provider(pi: ExtensionAPI): void {
  const faux = createFauxCore({ provider: "adaptive-faux", models: [{ id: "local" }] })
  faux.setResponses([fauxAssistantMessage("ADAPTIVE_PACKED_OK")])
  pi.registerProvider("adaptive-faux", {
    api: faux.api,
    baseUrl: "http://127.0.0.1:1",
    apiKey: "local-faux-test-data",
    models: faux.models,
    streamSimple: faux.streamSimple,
  })
}
