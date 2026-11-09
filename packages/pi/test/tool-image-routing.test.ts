// covers: ["ADP-017", "ADP-019", "ADP-029"]
import { expect, it } from "vitest"
import type { Message } from "@earendil-works/pi-ai"
import { defaultSettings } from "@coool/adaptive-core/state/settings/parse"
import { readReceipts } from "../src/receipts.js"
import { routingFixture } from "./routing-fixture.js"

it("keeps tool-result images in both observed and registered-route compatibility demand", async () => {
  const f = routingFixture({
    ...defaultSettings(),
    tiers: {
      quick: [],
      standard: [
        { providerID: "local", id: "a" },
        { providerID: "local", id: "b" },
      ],
      advanced: [],
    },
  })
  const history: Message[] = [
    {
      role: "toolResult",
      toolCallId: "read-image",
      toolName: "read",
      content: [{ type: "image", data: "AA==", mimeType: "image/png" }],
      isError: false,
      timestamp: 0,
    },
  ]
  const prompt: Message = { role: "user", content: "describe the image", timestamp: 1_000 }
  const ctx = {
    model: f.a,
    modelRegistry: {
      getAvailable: () =>
        f.faux.models.map((model) => ({
          ...model,
          input: model.id === "b" ? ["text" as const, "image" as const] : ["text" as const],
        })),
    },
    sessionManager: {
      getBranch: () => [],
      getSessionId: () => "session",
      buildSessionProjection: () => ({
        messages: history,
        entries: [],
        thinkingLevel: "off",
        model: null,
      }),
    },
  }
  await f.observe({ type: "input", source: "interactive", text: "describe the image" }, ctx)
  const [receipt] = await readReceipts(f.sources.receipts)
  expect(receipt?.decision).toMatchObject({
    kind: "observe-only",
    would: { kind: "apply", model: { id: "b" } },
  })
  const routed = await f.route()(
    { model: f.a, reason: "user", thinkingLevel: "off", messages: [...history, prompt] },
    ctx,
  )
  expect(routed.model.id).toBe("b")
})
