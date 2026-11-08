/**
 * One-shot timer for the parked-work wake. Unref'd: a pending wake must not
 * keep a headless `opencode run` process alive after its work is done.
 */
export function unrefTimeout(callback: () => void, delayMs: number): () => void {
  const timer = setTimeout(callback, delayMs)
  timer.unref()
  return () => {
    clearTimeout(timer)
  }
}
