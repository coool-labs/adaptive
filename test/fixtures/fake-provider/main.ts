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
import { createFakeProvider } from "./server.js"
import { FAKE_SCENARIOS } from "./scenarios.js"

const portArg = process.argv.findIndex((arg) => arg === "--port")
const raw = portArg >= 0 ? (process.argv[portArg + 1] ?? "") : ""
const port = Number.parseInt(raw, 10)
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error("usage: main.ts --port <fixed tcp port> [--fail-after-title]")
  process.exit(2)
}

const failAfterTitle = process.argv.some((arg) => arg === "--fail-after-title")
const success = FAKE_SCENARIOS["recovery-after-n"].behaviors.at(-1)
const quotaExhausted = FAKE_SCENARIOS["quota-exhausted"].behaviors.at(0)
if (success === undefined || quotaExhausted === undefined) {
  console.error("recovery-after-n / quota-exhausted scenarios are malformed")
  process.exit(2)
}

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
