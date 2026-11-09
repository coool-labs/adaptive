import { expect, it } from "vitest"
import { requirementCatalogue, requirementE2ESource } from "../requirements.js"

const doc =
  "- **ADP-001** — shared\n- **ADP-002** — OpenCode\n- **ADP-003** — Pi\n- [both]: ADP-001\n- [opencode]: ADP-002\n- [pi]: ADP-003"

it("counts only the selected host's real SDK, packed and UI journeys as E2E", () => {
  for (const prefix of ["runtime", "packed", "tui", "matrix"])
    expect(requirementE2ESource("pi", `test/${prefix}/journey.spec.ts`)).toBe(true)
  expect(requirementE2ESource("pi", "test\\packed\\journey.spec.ts")).toBe(true)
  expect(requirementE2ESource("pi", "test/unit.test.ts")).toBe(false)
  expect(requirementE2ESource("pi", "test/e2e-tui/journey.spec.ts")).toBe(false)
  for (const prefix of ["runtime-e2e", "e2e-web", "e2e-gui", "e2e-tui", "plugin-test"])
    expect(requirementE2ESource("opencode", `test/${prefix}/journey.spec.ts`)).toBe(true)
  expect(requirementE2ESource("opencode", "test/packed/journey.spec.ts")).toBe(false)
})

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
