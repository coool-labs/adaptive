/**
 * Passive Codex/ChatGPT capacity telemetry (ADP-020).
 *
 * The only consumed evidence is the `x-codex-*` response-header family
 * (including LiteLLM's `llm_provider-x-codex-*` relay form), captured from the
 * `http.response` hook by the wiring-supplied allowlist. Verified wire facts:
 * `x-codex-primary-used-percent` (5h window), `x-codex-secondary-used-percent`
 * (weekly window), `x-codex-{primary,secondary}-window-minutes`,
 * `x-codex-{primary,secondary}-reset-after-seconds`, and
 * `x-codex-{primary,secondary}-reset-at` — where `reset-at` is documented to
 * sometimes arrive as an EMPTY STRING while `reset-after-seconds` is present.
 * Everything is validated; unparseable telemetry produces no estimate rather
 * than a guess.
 */

export const CODEX_SENSOR_ID = "codex-headers"

/** The telemetry windows Codex headers report. Primary is the 5h window. */
export const CODEX_WINDOW_KINDS = ["primary", "secondary"] as const satisfies readonly string[]

export type CodexWindowKind = (typeof CODEX_WINDOW_KINDS)[number]

export interface CodexWindow {
  /** Usage percentage in [0, 100] — the window exists only if this is valid. */
  readonly usedPercent: number
  /** Validated finite non-negative seconds until reset, when reported. */
  readonly resetAfterSeconds?: number | undefined
  /** Validated finite non-negative epoch-seconds reset timestamp, when reported. */
  readonly resetAtSeconds?: number | undefined
}

/** One validated header observation. `null` windows are simply absent. */
export interface CodexUsage {
  readonly primary?: CodexWindow | undefined
  readonly secondary?: CodexWindow | undefined
}
