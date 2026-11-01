// covers: ["ADP-006", "ADP-007"]
import { describe, expect, it } from "vitest"

import {
  resourceChain,
  resourceKeyID,
  resourceScope,
} from "../../../src/health/resource-health/key.js"

describe("resource keys", () => {
  describe("resourceScope", () => {
    it("derives the scope from the most specific present field", () => {
      expect(resourceScope({ providerID: "p" })).toBe("provider")
      expect(resourceScope({ providerID: "p", accountID: "a" })).toBe("account")
      expect(resourceScope({ providerID: "p", modelID: "m" })).toBe("model")
      expect(resourceScope({ providerID: "p", accountID: "a", modelID: "m" })).toBe("model")
      expect(resourceScope({ providerID: "p", modelID: "m", variantID: "v" })).toBe("variant")
      expect(resourceScope({ providerID: "p", accountID: "a", modelID: "m", variantID: "v" })).toBe(
        "variant",
      )
    })
  })

  describe("resourceKeyID", () => {
    it("distinguishes keys at every scope", () => {
      const provider = resourceKeyID({ providerID: "p" })
      const account = resourceKeyID({ providerID: "p", accountID: "a" })
      const model = resourceKeyID({ providerID: "p", modelID: "m" })
      const variant = resourceKeyID({ providerID: "p", modelID: "m", variantID: "v" })
      expect(new Set([provider, account, model, variant]).size).toBe(4)
    })

    it("is stable for equal keys", () => {
      expect(resourceKeyID({ providerID: "p", modelID: "m" })).toBe(
        resourceKeyID({ providerID: "p", modelID: "m" }),
      )
    })
  })

  describe("resourceChain", () => {
    it("returns only the provider for a provider key", () => {
      expect(resourceChain({ providerID: "p" })).toEqual([{ providerID: "p" }])
    })

    it("walks provider → account → model → variant for a full key", () => {
      expect(
        resourceChain({ providerID: "p", accountID: "a", modelID: "m", variantID: "v" }),
      ).toEqual([
        { providerID: "p" },
        { providerID: "p", accountID: "a" },
        { providerID: "p", accountID: "a", modelID: "m" },
        { providerID: "p", accountID: "a", modelID: "m", variantID: "v" },
      ])
    })

    it("keeps a model level for keys without an account (OpenCode model refs)", () => {
      expect(resourceChain({ providerID: "p", modelID: "m", variantID: "v" })).toEqual([
        { providerID: "p" },
        { providerID: "p", modelID: "m" },
        { providerID: "p", modelID: "m", variantID: "v" },
      ])
    })

    it("ignores a degenerate variant field without a model field", () => {
      expect(resourceChain({ providerID: "p", variantID: "v" })).toEqual([{ providerID: "p" }])
    })
  })
})
