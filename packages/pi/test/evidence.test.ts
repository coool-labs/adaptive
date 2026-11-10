// covers: ["ADP-008", "ADP-065"]
import { readdirSync, readFileSync } from "node:fs"
import { classifyFailure } from "@coool/adaptive-core/health/classifier/classify"
import { FAILURE_CATEGORIES } from "@coool/adaptive-core/health/classifier/types"
import { expect, it } from "vitest"
import { failureEvidence } from "../src/evidence.js"

interface CorpusEntry {
  readonly source: string
  readonly stopReason: string
  readonly errorMessage?: string
  readonly category: string
  readonly definitive: boolean
}

function corpus(version: string): readonly CorpusEntry[] {
  const raw: unknown = JSON.parse(
    readFileSync(new URL(`fixtures/pi-errors/${version}.json`, import.meta.url), "utf8"),
  )
  if (!Array.isArray(raw)) {
    throw new Error(`pi-errors/${version}.json: expected an array`)
  }
  return raw.map((entry: unknown, index): CorpusEntry => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`pi-errors/${version}.json[${String(index)}]: expected an object`)
    }
    const field = (key: string): unknown => Object.getOwnPropertyDescriptor(entry, key)?.value
    const source = field("source")
    const stopReason = field("stopReason")
    const errorMessage = field("errorMessage")
    const category = field("category")
    const definitive = field("definitive")
    if (
      typeof source !== "string" ||
      typeof stopReason !== "string" ||
      typeof category !== "string" ||
      typeof definitive !== "boolean" ||
      !(errorMessage === undefined || typeof errorMessage === "string")
    ) {
      throw new Error(`pi-errors/${version}.json[${String(index)}]: malformed entry`)
    }
    return {
      source,
      stopReason,
      category,
      definitive,
      ...(errorMessage === undefined ? {} : { errorMessage }),
    }
  })
}

const corpusVersions = readdirSync(new URL("fixtures/pi-errors/", import.meta.url))
  .filter((file) => file.endsWith(".json"))
  .map((file) => file.slice(0, -".json".length))

it.each(corpusVersions)("classifies every labelled Pi %s provider error", (version) => {
  expect(corpus(version).length).toBeGreaterThan(0)
  for (const entry of corpus(version)) {
    const result = classifyFailure(failureEvidence(entry))
    expect({
      source: entry.source,
      category: result.category,
      definitive: result.definitive,
    }).toEqual({
      source: entry.source,
      category: entry.category,
      definitive: entry.definitive,
    })
  }
})

it("keeps a labelled corpus for the minimum supported Pi version and every concrete matrix version", () => {
  const matrix: unknown = JSON.parse(
    readFileSync(new URL("../pi-host-matrix.json", import.meta.url), "utf8"),
  )
  const versions: unknown = Object.getOwnPropertyDescriptor(matrix, "versions")?.value
  if (!Array.isArray(versions)) throw new Error("pi-host-matrix.json: versions must be an array")
  for (const version of versions.filter((entry) => entry !== "latest"))
    expect(corpusVersions).toContain(version)
})

it.each(corpusVersions)(
  "labels at least one real Pi %s error for every failure category",
  (version) => {
    expect(new Set(corpus(version).map((entry) => entry.category))).toEqual(
      new Set(FAILURE_CATEGORIES),
    )
  },
)

it("trusts only status prefixes pi-ai writes itself", () => {
  expect(failureEvidence({ stopReason: "error", errorMessage: "  429 slow down " })).toEqual({
    status: 429,
    text: "429 slow down",
  })
  expect(failureEvidence({ stopReason: "error", errorMessage: "503" })).toEqual({
    status: 503,
    text: "503",
  })
  // A status inside the body, a longer number, or a request id is only text.
  for (const errorMessage of [
    "upstream said 503",
    "4290 tokens remaining",
    "req_429abc failed",
    "Validation error: 400: bad input",
  ]) {
    expect(failureEvidence({ stopReason: "error", errorMessage })).toEqual({ text: errorMessage })
  }
  expect(failureEvidence({ stopReason: "error", errorMessage: "   " })).toEqual({})
  expect(failureEvidence({ stopReason: "aborted", errorMessage: "429 ignored" })).toEqual({
    interrupted: "user",
  })
})
