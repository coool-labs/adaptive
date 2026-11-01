/**
 * Cross-surface sync E2E (ADP-044): the server is the single source of truth
 * for settings, so a change made on one surface is observable on the other
 * without any surface-local state.
 *
 * Surface fidelity on opencode 2.2.5:
 * - The web surface is the real browser app; the plugin's settings page does
 *   not mount there (plugin GUIs mount only through the desktop shell's
 *   bridge — canary in web.spec.ts), so the web side speaks the plugin RPC
 *   from inside the page, the exact channel the GUI api binds.
 * - The TUI surface does mount the plugin bundle (its RPC path is driven for
 *   real by the Termwright journeys in test/e2e-tui/tui.spec.ts), but driving
 *   two interactive TUIs in one automated test is not automated, so the TUI
 *   side here is a typed client bound to the same RPC definition src/tui.ts
 *   binds (context.client.rpc(adaptiveRpc)).
 */
// covers: ["ADP-044"]
import { expect, test } from "@playwright/test"
import { OpenCode } from "@opencode/client"
import { adaptiveRpc } from "../../src/rpc/definition.js"
import { HOST_PASSWORD } from "../runtime-e2e/helpers.js"
import { connect, hostUrl, rpc } from "./app.js"

const surfaceClient = (): ReturnType<typeof OpenCode.make> =>
  OpenCode.make({
    baseUrl: hostUrl(),
    headers: {
      authorization: `Basic ${Buffer.from(`opencode:${HOST_PASSWORD}`).toString("base64")}`,
    },
  })

const bindSurface = (client: ReturnType<typeof OpenCode.make>) => client.rpc(adaptiveRpc)
type AdaptiveSurface = ReturnType<typeof bindSurface>

interface SettingsChangedWatch {
  /** Resolves the next event, or undefined once `timeoutMs` elapses. */
  next(timeoutMs: number): Promise<{ version: number } | undefined>
  close(): void
}

/**
 * One long-lived subscription pumped through a buffer, so an event emitted
 * while no caller is awaiting is still delivered on the next `next()`. A
 * timed-out `next()` retracts its waiter, so a late event lands in the
 * buffer instead of resolving a abandoned awaiter (which would lose it).
 */
const watchSettingsChanged = (adaptive: AdaptiveSurface): SettingsChangedWatch => {
  const controller = new AbortController()
  const stream = adaptive.events.subscribe("settings-changed", {
    signal: controller.signal,
  })
  const buffered: { version: number }[] = []
  const waiting: ((event: { version: number }) => void)[] = []
  void (async () => {
    for await (const event of stream) {
      const waiter = waiting.shift()
      if (waiter === undefined) {
        buffered.push(event.data)
        continue
      }
      waiter(event.data)
    }
  })()
  return {
    next: (timeoutMs) => {
      const bufferedEvent = buffered.shift()
      if (bufferedEvent !== undefined) return Promise.resolve(bufferedEvent)
      return new Promise((resolve) => {
        const waiter = (event: { version: number }): void => {
          clearTimeout(timer)
          resolve(event)
        }
        const timer = setTimeout(() => {
          const index = waiting.indexOf(waiter)
          if (index >= 0) waiting.splice(index, 1)
          resolve(undefined)
        }, timeoutMs)
        waiting.push(waiter)
      })
    },
    close: () => {
      controller.abort()
    },
  }
}

/**
 * Prove the subscription is live before the change under test: a same-value
 * patch still succeeds (applyPatch accepts it) and emits, so it probes the
 * pipe without disturbing the state under test. A subscription established
 * after a probe misses only that probe's event and the loop re-probes.
 */
const liveWatch = async (adaptive: AdaptiveSurface): Promise<SettingsChangedWatch> => {
  const watch = watchSettingsChanged(adaptive)
  for (;;) {
    await adaptive["settings.set"]({ inviteDismissed: false })
    const event = await watch.next(2_000)
    if (event !== undefined) return watch
  }
}

test.describe("cross-surface sync (ADP-044)", () => {
  test("a settings change made in the web surface reaches the TUI surface live", async ({
    page,
  }) => {
    await connect(page, HOST_PASSWORD)
    const client = surfaceClient()
    const other = bindSurface(client)
    const watch = await liveWatch(other)
    try {
      await rpc(page, "settings.set", { mode: "control" })
      const event = await watch.next(15_000)
      expect(event, "settings-changed event").toBeDefined()
      if (event === undefined) return
      expect(event.version).toBe(1)
      expect((await other["settings.get"]()).mode).toBe("control")
      expect((await other["status.get"]()).mode).toBe("control")
    } finally {
      watch.close()
    }
    await rpc(page, "settings.set", { mode: "observe" })
  })

  test("a settings change made on the TUI surface is visible in the web surface after reload", async ({
    page,
  }) => {
    const client = surfaceClient()
    const other = bindSurface(client)
    const watch = await liveWatch(other)
    try {
      const result = await other["settings.set"]({ mode: "control" })
      expect(result.ok).toBe(true)
      const event = await watch.next(15_000)
      expect(event, "settings-changed event").toBeDefined()
      // The web surface holds no settings state: a fresh load reads the
      // server and observes the same settings.
      await connect(page, HOST_PASSWORD)
      expect((await rpc(page, "settings.get"))["mode"]).toBe("control")
      expect((await rpc(page, "status.get"))["mode"]).toBe("control")
    } finally {
      watch.close()
    }
    await other["settings.set"]({ mode: "observe" })
  })
})
