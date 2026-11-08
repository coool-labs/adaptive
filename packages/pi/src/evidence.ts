// covers: ["ADP-008", "ADP-065"]
/**
 * Failure evidence from a Pi assistant message. Pi reports provider failures
 * only as free-text `errorMessage`; there is no structured status field. The
 * pi-ai adapters do place the HTTP status deterministically at the start of
 * that text — SDK errors read "429 You exceeded…" or "503 status code (no
 * body)", and pi-ai's `formatProviderError` writes "429: <body>" or
 * "<Provider> API error (429): …" — so the status is recovered from those
 * prefixes only. A status mentioned later in a body is not trusted, and
 * everything else stays textual, non-definitive evidence (ADP-008).
 */
import type { ErrorEvidence } from "@coool/adaptive-core/health/classifier/types"

/** The structural subset of Pi's `AssistantMessage` this module reads. */
export interface FailedMessage {
  readonly stopReason: string
  readonly errorMessage?: string | undefined
}

const STATUS_PREFIXES: readonly RegExp[] = [
  /^(\d{3})(?=[\s:]|$)/,
  /^[\w .-]+ API error \((\d{3})\):/,
]

// pi-ai's Bedrock adapter replaces the SDK exception name with a fixed
// human-readable prefix and drops the status. AWS documents these exceptions
// as HTTP 429 and 503; without this, "Throttling error: Too many tokens…"
// would read as context overflow.
const BEDROCK_STATUS: readonly (readonly [string, number])[] = [
  ["Throttling error: ", 429],
  ["Service unavailable: ", 503],
]

function statusOf(text: string): number | undefined {
  for (const pattern of STATUS_PREFIXES) {
    const digits = pattern.exec(text)?.[1]
    if (digits !== undefined) {
      return Number(digits)
    }
  }
  return BEDROCK_STATUS.find(([prefix]) => text.startsWith(prefix))?.[1]
}

export function failureEvidence(message: FailedMessage): ErrorEvidence {
  // Pi marks a user abort (Esc, or the abort signal during retry backoff) as
  // its own stop reason; it is never a provider failure (ADP-010).
  if (message.stopReason === "aborted") {
    return { interrupted: "user" }
  }
  const text = message.errorMessage?.trim() ?? ""
  if (text === "") {
    return {}
  }
  const status = statusOf(text)
  return status === undefined ? { text } : { status, text }
}
