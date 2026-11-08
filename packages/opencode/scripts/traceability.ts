// covers: ["ADP-047"]
/**
 * Requirements traceability gate (ADP-047; TEST_STRATEGY.md §Traceability).
 *
 * Scans `covers:` literals across the test suite and repo-level coverage
 * sources, compares them against the requirement ids defined in
 * docs/REQUIREMENTS.md, and fails when:
 *   1. a declared id is not defined in docs/REQUIREMENTS.md (typo gate),
 *   2. a requirement has no declaring file at all,
 *   3. an E2E-applicable requirement has no declaration in an E2E file.
 *
 * Always writes test-artifacts/traceability.json, then exits 1 with concise
 * error lines or 0 with a short summary. Run via `npm run traceability`.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

interface RequirementCoverage {
  id: string
  files: string[]
  e2eFiles: string[]
  e2eApplicable: boolean
}

/**
 * Requirements exempt from the E2E-coverage check. Every other requirement is
 * treated as E2E-applicable (safe default: a newly added requirement must be
 * either covered E2E or consciously exempted here, with a justification).
 */
const NOT_E2E_APPLICABLE: Readonly<Record<string, string>> = {
  "ADP-004":
    "architecture invariant (no LLM/keyword routing) — proven structurally by unit/property tests",
  "ADP-006": "resource identity semantics — unit-level key derivation",
  // The hierarchy/quarantine narrowing is unit-level; the runtime-observable
  // half-open/breaker behavior is ADP-019, which is E2E-applicable.
  "ADP-007": "health hierarchy/quarantine internals — unit-level",
  "ADP-011": "boundedness is structural — E2E cannot prove non-termination",
  "ADP-012": "narrowest-scope quarantine semantics — unit-level",
  "ADP-020": "capacity sensor telemetry — unit-level adapter boundary",
  "ADP-021": "draining has no runtime emitter on host 2.2.5 (TEST_STRATEGY documented limitation)",
  "ADP-027":
    "auxiliary requests have no runtime observation surface; title calls are host-internal",
  "ADP-032":
    "first-install invitation lives in TUI/GUI surfaces that cannot mount on 2.2.5 (documented limitation)",
  "ADP-033": "TUI dialog journeys unreachable on 2.2.5 — canary-documented limitation",
  "ADP-034": "GUI SettingsPage is desktop-bridge-only on 2.2.5 (documented limitation)",
  "ADP-037": "the coverage gate itself",
  "ADP-038": "property/state-machine tests",
  "ADP-039": "fake-provider fixture unit tests",
  "ADP-046": "regression policy documentation",
  "ADP-047": "this gate",
  "ADP-048":
    "packaging validation — structural test; pack/dry-run validation lands with the packaging task",
  "ADP-050": "the verify:release script itself",
  "ADP-052":
    "prompt-overhead structure — the absence of an LLM call is structural, not runtime-observable",
  "ADP-053": "performance measurement — unit-level timing bound",
}

/** Path prefixes whose files count as E2E coverage sources. */
const E2E_PREFIXES = [
  "test/runtime-e2e/",
  "test/e2e-web/",
  "test/e2e-gui/",
  "test/e2e-tui/",
  "test/plugin-test/",
] as const

const COVERS_LITERAL = /covers:\s*\[[^\]]*\]/g
const ADP_ID = /ADP-\d{3}/g
const REQUIREMENT_HEADING = /^- \*\*(ADP-\d{3})\*\*/

function walkFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...walkFiles(path))
    } else {
      out.push(path)
    }
  }
  return out
}

function isE2EFile(file: string): boolean {
  const normalized = file.split("\\").join("/")
  return E2E_PREFIXES.some((prefix) => normalized.startsWith(prefix))
}

function requirementIds(doc: string): string[] {
  const ids: string[] = []
  for (const line of doc.split("\n")) {
    const match = REQUIREMENT_HEADING.exec(line)
    const id = match?.[1]
    if (id !== undefined) ids.push(id)
  }
  return ids
}

function declaredIds(text: string): Set<string> {
  const ids = new Set<string>()
  for (const literal of text.matchAll(COVERS_LITERAL)) {
    for (const id of literal[0].matchAll(ADP_ID)) {
      ids.add(id[0])
    }
  }
  return ids
}

const requirementIdsAll = requirementIds(readFileSync("../../docs/REQUIREMENTS.md", "utf8"))

// Coverage sources: the test suite plus the repo-level files that carry
// `covers:` declarations (config gate, policy docs, repo scripts).
const scriptFiles = readdirSync("scripts")
  .filter((name) => name.endsWith(".ts"))
  .map((name) => join("scripts", name))
const sources: string[] = [
  ...walkFiles("test").filter((file) => /\.(test|spec)\.ts$/.test(file)),
  "test/plugin-test/scenarios.ts",
  "vitest.config.ts",
  "../../CONTRIBUTING.md",
  ...scriptFiles,
].sort()

const declarations = new Map<string, Set<string>>()
for (const file of sources) {
  const ids = declaredIds(readFileSync(file, "utf8"))
  if (ids.size > 0) declarations.set(file, ids)
}

const byId = new Map<string, { files: string[]; e2eFiles: string[] }>()
for (const [file, ids] of declarations) {
  const e2e = isE2EFile(file)
  for (const id of ids) {
    const entry = byId.get(id) ?? { files: [], e2eFiles: [] }
    entry.files.push(file)
    if (e2e) entry.e2eFiles.push(file)
    byId.set(id, entry)
  }
}

const known = new Set(requirementIdsAll)
const errors: string[] = []
for (const [file, ids] of declarations) {
  for (const id of ids) {
    if (!known.has(id))
      errors.push(`${id} declared in ${file} is not defined in docs/REQUIREMENTS.md`)
  }
}
for (const id of requirementIdsAll) {
  const entry = byId.get(id)
  if (entry === undefined) {
    errors.push(`${id} has no declaring files`)
    continue
  }
  const applicable = !Object.hasOwn(NOT_E2E_APPLICABLE, id)
  if (applicable && entry.e2eFiles.length === 0) {
    errors.push(
      `${id} is E2E-applicable but is only declared by non-E2E files (E2E: ${E2E_PREFIXES.join(", ")})`,
    )
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  requirements: requirementIdsAll
    .slice()
    .sort()
    .map((id): RequirementCoverage => {
      const entry = byId.get(id)
      return {
        id,
        files: entry === undefined ? [] : entry.files.slice().sort(),
        e2eFiles: entry === undefined ? [] : entry.e2eFiles.slice().sort(),
        e2eApplicable: !Object.hasOwn(NOT_E2E_APPLICABLE, id),
      }
    }),
}
mkdirSync("test-artifacts", { recursive: true })
writeFileSync(join("test-artifacts", "traceability.json"), `${JSON.stringify(report, null, 2)}\n`)

if (errors.length > 0) {
  for (const error of errors) console.error(`traceability: ${error}`)
  console.error(`traceability: FAILED with ${String(errors.length)} error(s)`)
  process.exit(1)
}
const e2eCovered = report.requirements.filter(
  (r) => r.e2eApplicable && r.e2eFiles.length > 0,
).length
const e2eRequired = report.requirements.filter((r) => r.e2eApplicable).length
console.log(
  `traceability: ${String(report.requirements.length)} requirements, ` +
    `${String(declarations.size)} declaring files, ` +
    `${String(e2eCovered)}/${String(e2eRequired)} E2E-applicable covered E2E — OK`,
)
