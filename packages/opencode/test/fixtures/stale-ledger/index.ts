// Stands in for an older Adaptive release the host loaded earlier in the same
// process: it publishes the process ledger as that release shaped it (no
// health-reset or resume registries). Seeded at import so it is in place
// before the plugin under test sets up, whatever order the host starts them.
import { Plugin } from "@opencode/plugin"

Reflect.set(globalThis, Symbol.for("coool.adaptive/process-ledger"), {
  live: new Set(),
  claims: new Set(),
  takeovers: new Map(),
  switches: new Map(),
  continuations: new Map(),
  wakes: new Map(),
  parked: new Set(),
})

export default Plugin.define({ id: "e2e.stale-ledger", setup: () => undefined })
