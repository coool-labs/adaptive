/**
 * Standalone fake-provider process for PTY-based TUI E2E: the opencode TUI
 * runs in its own terminal session and can only reach the provider over the
 * network, so the fixture must outlive the test process that spawned it.
 * Fixed --port (the TUI project's opencode.json needs the URL before boot).
 */
import { createFakeProvider } from "./server.js"
import { FAKE_SCENARIOS } from "./scenarios.js"

const portArg = process.argv.findIndex((arg) => arg === "--port")
const raw = portArg >= 0 ? (process.argv[portArg + 1] ?? "") : ""
const port = Number.parseInt(raw, 10)
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error("usage: main.ts --port <fixed tcp port>")
  process.exit(2)
}

const provider = await createFakeProvider(
  { behaviors: [...FAKE_SCENARIOS.success.behaviors] },
  { port },
)

console.log(`FAKE_PROVIDER_READY port=${String(port)}`)

const shutdown = (): void => {
  void provider.close().then(() => process.exit(0))
}
process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)
