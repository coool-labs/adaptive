// covers: ["ADP-013", "ADP-017", "ADP-019", "ADP-029"]
import { expect, it, vi } from "vitest"
import fc from "fast-check"
import type { Message } from "@earendil-works/pi-ai"
import { defaultSettings } from "@coool/adaptive-core/state/settings/parse"
import type { ModelRef } from "@coool/adaptive-core/routing/work-unit/types"
import type { Decision } from "@coool/adaptive-core/routing/scheduler/types"
import { observeCodexHeaders } from "../src/capacity.js"
import { observeOutcome, withHealth } from "../src/health.js"
import { prepareAdmission, virtualModels } from "../src/host/routing.js"
import { readReceipts } from "../src/receipts.js"
import { routingFixture } from "./routing-fixture.js"

// A lease ID belongs to dispatch, not the recommendation's semantic identity.
function recommendation(decision: Decision) {
  if (decision.kind !== "apply") return decision
  return { ...decision, evidence: { skipped: decision.evidence.skipped } }
}

it("keeps actual observe/prepareAdmission/active decisions identical across host inputs", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.record({
        availableA: fc.boolean(),
        availableB: fc.boolean(),
        variant: fc.constantFrom(undefined, "high", "imaginary"),
        pin: fc.constantFrom("none", "a", "b", "missing"),
        tools: fc.boolean(),
        toolSupport: fc.constantFrom(undefined, true, false),
        image: fc.boolean(),
        acceptsImage: fc.boolean(),
        historySize: fc.integer({ min: 0, max: 1200 }),
        contextSize: fc.integer({ min: 1, max: 1000 }),
        health: fc.constantFrom("healthy", "limited", "open", "probe"),
        capacity: fc.constantFrom("unknown", "ready", "draining", "exhausted"),
      }),
      async (input) => {
        const ref: ModelRef = {
          providerID: "local",
          id: "a",
          ...(input.variant === undefined ? {} : { variant: input.variant }),
        }
        const f = routingFixture({
          ...defaultSettings(),
          pin: input.pin === "none" ? null : { ...ref, id: input.pin },
          tiers: { quick: [], standard: [ref, { providerID: "local", id: "b" }], advanced: [] },
        })
        vi.mocked(f.sources.capabilities).mockResolvedValue(
          input.toolSupport === undefined
            ? []
            : [
                { providerID: "local", id: "a", tools: input.toolSupport },
                { providerID: "local", id: "b", tools: input.toolSupport },
              ],
        )
        f.host.getActiveTools.mockReturnValue(input.tools ? ["read"] : [])
        const now = input.health === "probe" ? 31_000 : 1_000
        const seedHealth = { ...f.sources.health, clock: () => 1_000 }
        if (input.health !== "healthy")
          await withHealth(seedHealth, (registry) => {
            for (let n = 0; n < (input.health === "limited" ? 1 : 5); n++)
              observeOutcome(registry, ref, {
                stopReason: "error",
                errorMessage:
                  input.health === "limited" ? "429 rate limit" : "503 Service Unavailable",
              })
          })
        // Clock advancement is explicit, with no wall-clock waits.
        vi.spyOn(f.sources.health, "clock").mockReturnValue(now)
        if (input.capacity !== "unknown")
          await observeCodexHeaders(f.sources.capacity, "local", {
            "x-codex-primary-used-percent": { ready: "20", draining: "95", exhausted: "100" }[
              input.capacity
            ],
            "x-codex-primary-reset-after-seconds": "120",
          })
        const history: Message[] = [
          { role: "user", content: "h".repeat(input.historySize * 4), timestamp: 0 },
        ]
        const images = input.image
          ? [{ type: "image" as const, data: "AA==", mimeType: "image/png" }]
          : []
        const messages: Message[] = [
          ...history,
          { role: "user", timestamp: now, content: [{ type: "text", text: "next" }, ...images] },
        ]
        const ctx = {
          model: f.a,
          modelRegistry: {
            getAvailable: () =>
              f.faux.models
                .filter((model) => (model.id === "a" ? input.availableA : input.availableB))
                .map((model) => ({
                  ...model,
                  contextWindow: input.contextSize,
                  input: input.acceptsImage
                    ? ["text" as const, "image" as const]
                    : ["text" as const],
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
        const request = {
          model: f.a,
          reason: "user" as const,
          thinkingLevel: "off" as const,
          messages,
        }
        const healthBefore = structuredClone(await f.sources.health.file.read())
        const capacityBefore = structuredClone(await f.sources.capacity.file.read())
        expect(
          await f.observe({ type: "input", source: "interactive", text: "next", images }, ctx),
        ).toEqual({ action: "continue" })
        expect(await f.sources.health.file.read()).toEqual(healthBefore)
        expect(await f.sources.capacity.file.read()).toEqual(capacityBefore)
        expect(f.host.appendEntry).not.toHaveBeenCalled()
        const [receipt] = await readReceipts(f.sources.receipts)
        if (receipt?.decision.kind !== "observe-only") throw new Error("observer did not run")
        const prepared = await prepareAdmission(
          "auto",
          request,
          ctx,
          f.sources,
          f.host.getActiveTools,
        )
        const { decision } = await prepared.choose()
        expect(recommendation(receipt.decision.would)).toEqual(recommendation(decision))
        // Fresh snapshot for real dispatch: an earlier active admission may own a probe.
        await f.sources.health.file.update(() => ({ next: healthBefore, result: undefined }))
        const [active] = virtualModels(f.sources, f.host.getActiveTools)
        if (active === undefined) throw new Error("missing active route")
        if (decision.kind === "apply") {
          const routed = await active.route(request, ctx)
          expect(routed.model.id).toBe(decision.model.id)
          if (decision.model.variant !== undefined)
            expect(routed.thinkingLevel).toBe(decision.model.variant)
        } else if (decision.kind === "park") {
          await expect(active.route(request, ctx)).rejects.toThrow(
            `Adaptive unavailable: ${decision.reason}`,
          )
        } else {
          const fallback = prepared.deferFallback()
          if (fallback === undefined)
            await expect(active.route(request, ctx)).rejects.toThrow("not set up")
          else expect((await active.route(request, ctx)).model.id).toBe(fallback.id)
        }
      },
    ),
    { seed: 19247, numRuns: 150 },
  )
})
