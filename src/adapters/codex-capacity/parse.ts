/**
 * Untrusted-header validation. Header values arrive from provider responses
 * (or relays); every field is parsed defensively and a window is admitted only
 * when its usage percentage is trustworthy. Reset fields that fail validation
 * are dropped field-wise — they cannot invalidate a valid percentage.
 */
import type { CodexUsage, CodexWindow, CodexWindowKind } from "./types.js"
import { CODEX_WINDOW_KINDS } from "./types.js"

/**
 * LiteLLM relays Codex headers under a provider prefix, e.g.
 * `llm_provider-x-codex-primary-used-percent`. Matching on the substring keeps
 * the parser independent of which relay prefix is used.
 */
export const CODEX_HEADER_MARK = "x-codex-"

/**
 * Allowlist predicate for the `http.response` capture option: matches plain
 * and LiteLLM-prefixed Codex telemetry header names (case already lowered by
 * the caller). Only quota telemetry passes — no other response header is ever
 * captured.
 */
export function isCodexHeaderName(lowercaseName: string): boolean {
  return lowercaseName.includes(CODEX_HEADER_MARK)
}

interface WindowAccumulator {
  usedPercent?: number | undefined
  resetAfterSeconds?: number | undefined
  resetAtSeconds?: number | undefined
}

function finiteAtLeast(value: string, min: number): number | undefined {
  // An empty (or whitespace-only) value must not fall through Number("") === 0.
  const trimmed = value.trim()
  if (trimmed === "") {
    return undefined
  }
  const parsed = Number(trimmed)
  if (!Number.isFinite(parsed) || parsed < min) {
    return undefined
  }
  return parsed
}

function emptyAccumulator(): WindowAccumulator {
  return { usedPercent: undefined, resetAfterSeconds: undefined, resetAtSeconds: undefined }
}

function takenValue(accumulator: WindowAccumulator, suffix: string): number | undefined {
  switch (suffix) {
    case "used-percent":
      return accumulator.usedPercent
    case "reset-after-seconds":
      return accumulator.resetAfterSeconds
    case "reset-at":
      return accumulator.resetAtSeconds
    default:
      return undefined
  }
}

function applyField(accumulator: WindowAccumulator, suffix: string, value: string): void {
  // First valid value per field wins; invalid or duplicate values are ignored.
  if (takenValue(accumulator, suffix) !== undefined) {
    return
  }
  switch (suffix) {
    case "used-percent": {
      // The percentage is the window's existence test: out of range or
      // unparseable values never admit a window.
      const usedPercent = finiteAtLeast(value, 0)
      if (usedPercent !== undefined && usedPercent <= 100) {
        accumulator.usedPercent = usedPercent
      }
      return
    }
    case "reset-after-seconds": {
      const resetAfterSeconds = finiteAtLeast(value, 0)
      if (resetAfterSeconds !== undefined) {
        accumulator.resetAfterSeconds = resetAfterSeconds
      }
      return
    }
    case "reset-at": {
      // Documented wire quirk: reset-at can be an empty string while
      // reset-after-seconds carries the real value. Empty and unparseable
      // values are dropped, never guessed at.
      const resetAtSeconds = finiteAtLeast(value, 0)
      if (resetAtSeconds !== undefined) {
        accumulator.resetAtSeconds = resetAtSeconds
      }
      return
    }
    default:
      // window-minutes and unknown suffixes carry no reading information.
      return
  }
}

function windowOf(accumulator: WindowAccumulator): CodexWindow | undefined {
  const usedPercent = accumulator.usedPercent
  if (usedPercent === undefined) {
    return undefined
  }
  const { resetAfterSeconds, resetAtSeconds } = accumulator
  return {
    usedPercent,
    ...(resetAfterSeconds !== undefined ? { resetAfterSeconds } : {}),
    ...(resetAtSeconds !== undefined ? { resetAtSeconds } : {}),
  }
}

/**
 * Parse captured response headers into a validated usage snapshot. Header
 * lookup is case-insensitive and accepts LiteLLM-prefixed names; fields
 * accumulate per window in any order. Returns `null` when no window carries a
 * trustworthy usage percentage.
 */
export function parseCodexUsage(captured: Readonly<Record<string, string>>): CodexUsage | null {
  const accumulators: Record<CodexWindowKind, WindowAccumulator | undefined> = {
    primary: undefined,
    secondary: undefined,
  }
  for (const [rawName, value] of Object.entries(captured)) {
    const mark = rawName.toLowerCase().indexOf(CODEX_HEADER_MARK)
    if (mark < 0) {
      continue
    }
    const rest = rawName.slice(mark + CODEX_HEADER_MARK.length).toLowerCase()
    const separator = rest.indexOf("-")
    const kind = rest.slice(0, separator)
    if (!(CODEX_WINDOW_KINDS as readonly string[]).includes(kind)) {
      continue
    }
    const key = kind as CodexWindowKind
    const accumulator = accumulators[key] ?? emptyAccumulator()
    applyField(accumulator, rest.slice(separator + 1), value)
    accumulators[key] = accumulator
  }
  const primary = windowOf(accumulators.primary ?? emptyAccumulator())
  const secondary = windowOf(accumulators.secondary ?? emptyAccumulator())
  if (primary === undefined && secondary === undefined) {
    return null
  }
  return {
    ...(primary !== undefined ? { primary } : {}),
    ...(secondary !== undefined ? { secondary } : {}),
  }
}
