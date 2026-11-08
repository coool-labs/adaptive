/**
 * Standalone fake-provider process for PTY-based TUI E2E: the opencode TUI
 * runs in its own terminal session and can only reach the provider over the
 * network, so the fixture must outlive the test process that spawned it.
 * Fixed --port (the TUI project's opencode.json needs the URL before boot).
 * --fail-after-title serves one success (consumed by the unsupervised title
 * call) and then a persistent quota-shaped 429: the host treats that shape
 * as non-retryable, so the turn fails fast instead of grinding native
 * retries, and the 60s retry-after keeps the resulting health window alive
 * long enough for a status inspection.
 */
import { createFakeProvider } from "@coool/adaptive-testkit/fake-provider/server"
import {
  FAKE_SCENARIOS,
  type FakeProviderBehavior,
} from "@coool/adaptive-testkit/fake-provider/scenarios"

const portArg = process.argv.indexOf("--port")
const raw = portArg >= 0 ? (process.argv[portArg + 1] ?? "") : ""
const port = Number.parseInt(raw, 10)
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error("usage: main.ts --port <fixed tcp port> [--fail-after-title]")
  process.exit(2)
}

const failAfterTitle = process.argv.some((arg) => arg === "--fail-after-title")
const success = FAKE_SCENARIOS["recovery-after-n"].behaviors.at(-1)
const rawQuota = FAKE_SCENARIOS["quota-exhausted"].behaviors.at(0)
if (success === undefined || rawQuota === undefined) {
  console.error("recovery-after-n / quota-exhausted scenarios are malformed")
  process.exit(2)
}
// The health window mirrors Retry-After; 60s is tighter than the journey's
// dialog navigation can reliably beat, so the sidecar stretches it to 300s
// while keeping the quota shape (the host still fast-fails the turn).
const quotaExhausted: FakeProviderBehavior =
  rawQuota.status === 429 && rawQuota.headers !== undefined
    ? { ...rawQuota, headers: { ...rawQuota.headers, "retry-after": "300" } }
    : rawQuota

const provider = await createFakeProvider(
  failAfterTitle
    ? { behaviors: [success, quotaExhausted] }
    : { behaviors: [...FAKE_SCENARIOS.success.behaviors] },
  { port },
)

console.log(`FAKE_PROVIDER_READY port=${String(port)}`)

const shutdown = (): void => {
  void provider.close().then(() => process.exit(0))
}
process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)
