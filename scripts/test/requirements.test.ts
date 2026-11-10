import { readFileSync } from "node:fs"
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

it("rejects an ID defined twice instead of silently counting it once", () => {
  expect(() => requirementCatalogue(`${doc}\n- **ADP-002** — again`, "opencode")).toThrow(
    "ADP-002 is defined twice",
  )
})

it("reads CRLF documents the same as LF documents", () => {
  expect(requirementCatalogue(doc.replaceAll("\n", "\r\n"), "pi")).toEqual(
    requirementCatalogue(doc, "pi"),
  )
})

it("keeps the real requirements document consistent for both hosts", () => {
  const text = readFileSync(new URL("../../docs/REQUIREMENTS.md", import.meta.url), "utf8")
  const opencode = requirementCatalogue(text, "opencode")
  const pi = requirementCatalogue(text, "pi")
  expect(pi.all).toEqual(opencode.all)
  // The retired ID stays reserved: defined nowhere and never reused.
  expect(pi.all).not.toContain("ADP-049")
  expect(text).toContain("ADP-049")
  // Numbering is contiguous apart from the retired ID, so a typo'd ID cannot hide.
  const numbers = pi.all.map((id) => Number(id.slice(4)))
  expect(numbers).toEqual(
    Array.from({ length: Math.max(...numbers) }, (_, index) => index + 1).filter(
      (number) => number !== 49,
    ),
  )
  // The Pi-only block binds to Pi alone; OpenCode-only IDs never bind to Pi.
  for (const id of [
    "ADP-057",
    "ADP-058",
    "ADP-059",
    "ADP-060",
    "ADP-061",
    "ADP-062",
    "ADP-063",
    "ADP-064",
    "ADP-065",
  ]) {
    expect(pi.applicable).toContain(id)
    expect(opencode.applicable).not.toContain(id)
  }
  for (const id of ["ADP-025", "ADP-033", "ADP-034", "ADP-040", "ADP-044"]) {
    expect(opencode.applicable).toContain(id)
    expect(pi.applicable).not.toContain(id)
  }
  // Shared requirements apply to both.
  for (const id of ["ADP-001", "ADP-013", "ADP-024", "ADP-056"]) {
    expect(pi.applicable).toContain(id)
    expect(opencode.applicable).toContain(id)
  }
})
