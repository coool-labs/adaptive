import { expect, it } from "vitest"
import { requirementCatalogue } from "../requirements.js"

const doc =
  "- **ADP-001** — shared\n- **ADP-002** — OpenCode\n- **ADP-003** — Pi\n- [both]: ADP-001\n- [opencode]: ADP-002\n- [pi]: ADP-003"

it("keeps all IDs known while requiring only a host's applicable requirements", () => {
  expect(requirementCatalogue(doc, "opencode")).toEqual({
    all: ["ADP-001", "ADP-002", "ADP-003"],
    applicable: ["ADP-001", "ADP-002"],
  })
  expect(requirementCatalogue(doc, "pi").applicable).toEqual(["ADP-001", "ADP-003"])
  expect(requirementCatalogue("- ADP-049 — Retired", "pi")).toEqual({ all: [], applicable: [] })
})

it("rejects missing, unknown and duplicate scopes instead of silently skipping requirements", () => {
  expect(() => requirementCatalogue("- **ADP-001** — missing", "pi")).toThrow(
    "ADP-001 has no scope",
  )
  expect(() => requirementCatalogue(`${doc}\n- [typo]: ADP-001`, "pi")).toThrow(
    "unknown scope typo",
  )
  expect(() => requirementCatalogue(`${doc}\n- [pi]: ADP-999`, "pi")).toThrow(
    "ADP-999 is not defined",
  )
  expect(() => requirementCatalogue(`${doc}\n- [pi]: ADP-001`, "pi")).toThrow(
    "duplicate scope for ADP-001",
  )
  expect(requirementCatalogue("- [both]: none", "opencode")).toEqual({ all: [], applicable: [] })
})
