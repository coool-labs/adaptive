/**
 * Fail-open logging (ADP-031). The supervisor never throws from its public
 * entry points; unexpected failures are logged with a bounded scope line and
 * swallowed. Logging is the degradation path, not a channel for secrets —
 * only the error's string form, bounded, is emitted.
 */

/** Bound for the logged error text (bounded diagnostics, ADP-030 spirit). */
export const LOG_ERROR_LENGTH = 200

/** Log one swallowed internal failure under the plugin's namespace. */
export function logFailOpen(scope: string, error: unknown): void {
  const detail = String(error).slice(0, LOG_ERROR_LENGTH)
  console.error(`[coool.adaptive] ${scope}: ${detail}`)
}
