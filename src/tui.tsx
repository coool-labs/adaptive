/** @jsxImportSource @opentui/solid */
// The pragma pins the JSX runtime for this file. The host compiles plugin
// sources in a cache dir where its loader's tsconfig lookup finds nothing and
// its default (react/jsx-runtime) fails to resolve there (empirical, sibling
// @coool plugins); our own tsc build reads the same pragma, so dist/tui.js
// imports @opentui/solid/jsx-runtime — the renderer the slot render runs on.
/**
 * TUI entrypoint (ADP-033): registers the `/adaptive` slash command and
 * drives the dialog-based flows through typed RPC, plus the footer status
 * chip rendered through host UI slots. The TUI is a thin view — no local
 * settings state beyond the chip's reactive mode mirror; the server stays
 * the single source of truth. This file is the repo's one JSX surface.
 */
import { define } from "@opencode/plugin/tui/plugin"
import type { Context } from "@opencode/plugin/tui/plugin"
import { createStore } from "solid-js/store"
import { PLUGIN_ID } from "./plugin-id.js"
import { adaptiveRpc } from "./rpc/definition.js"
import type { OperatingMode } from "./core/scheduler/types.js"
import { parseMode } from "./state/settings/index.js"
import { runAdaptive } from "./ui/tui/controller.js"
import type { AdaptiveApi, AdaptiveView } from "./ui/tui/controller.js"
import { errorText } from "./ui/tui/options.js"
import type { ModelSummary } from "./ui/tui/tiers.js"

/** Footer chip appearance: label plus foreground color (null = theme default). */
export interface Chip {
  readonly text: string
  readonly fg: string | null
}

/**
 * Label/color mapping for the footer chip. Pure so the mapping is testable
 * without a JSX runtime: active is green (supervision engaged), observe is
 * the neutral default (visible but calm), off is a soft red — noticeable,
 * but calmer than full-brightness ANSI red, which reads as an error.
 */
export function chipFor(mode: OperatingMode): Chip {
  switch (mode) {
    case "active":
      return { text: "Adaptive · active", fg: "green" }
    case "observe":
      return { text: "Adaptive · observe", fg: null }
    case "off":
      return { text: "Adaptive · off", fg: "#e57373" }
  }
}

const BOOT_FETCH_RETRIES = 5
const BOOT_FETCH_RETRY_MS = 2000

export default define({
  id: PLUGIN_ID,
  setup(context: Context) {
    const client = context.client.rpc(adaptiveRpc)
    const api: AdaptiveApi = {
      settings: () => client["settings.get"](),
      setSettings: (patch) => client["settings.set"](patch),
      status: () => client["status.get"](),
      receipts: () => client["receipts.list"](),
      sessionMode: (sessionID) => client["session-mode.get"]({ sessionID }).then((out) => out.mode),
      setSessionMode: (sessionID, mode) => client["session-mode.set"]({ sessionID, mode }),
    }
    const view: AdaptiveView = {
      select: (options) => context.ui.dialog.select(options),
      confirm: (options) => context.ui.dialog.confirm(options),
      alert: (options) => context.ui.dialog.alert(options),
      toast: (message, variant) => {
        context.ui.toast.show({ message, variant })
      },
    }
    // Real OpenCode models for the tier editor search (ADP-033); structural
    // summaries keep the view models free of client types.
    const models = (): readonly ModelSummary[] => {
      const list = context.data.location.model.list(context.location)
      return (list ?? []).map((info) => ({
        providerID: info.providerID,
        modelID: info.modelID,
        name: info.name,
        variants: info.variants.map((variant) => variant.id),
      }))
    }
    context.keymap.layer(() => ({
      // "global" opts out of input-mode scoping: the default ("base") binds
      // the commands to one OpenCode input mode, which kept the palette from
      // matching them (the sibling @coool plugins register the same way).
      mode: "global",
      commands: [
        {
          id: "coool.adaptive.menu",
          title: "Adaptive",
          group: "Adaptive",
          palette: true,
          // Surface the command in the palette's suggested row: discovery was
          // the reason users never found the menu at all.
          suggested: true,
          slash: { name: "adaptive" },
          run: () => {
            // Inside a session the flows steer that session's mode override
            // (ADP-054); on home they patch the global mode.
            const current = context.ui.router.current()
            const sessionID = current.type === "session" ? current.sessionID : undefined
            void runAdaptive({
              api,
              view,
              models,
              ...(sessionID !== undefined ? { sessionID } : {}),
            }).catch((error: unknown) => {
              view.toast(errorText(error), "error")
            })
          },
        },
      ],
    }))

    // Footer chip state: a reactive mirror of the server's operating mode,
    // fetched once at boot and kept live via the settings-changed event, plus
    // the per-session overrides seen so far (ADP-054).
    const [chip, setChip] = createStore<{
      mode: OperatingMode | null
      sessions: Record<string, OperatingMode | null>
    }>({ mode: null, sessions: {} })

    const fetchMode = async (): Promise<boolean> => {
      try {
        const settings = await api.settings()
        const mode = parseMode(settings.mode)
        if (mode !== undefined) setChip("mode", mode)
        return true
      } catch {
        return false
      }
    }

    /**
     * One session's override, cached so the chip never re-fetches per render.
     * A fetch failure caches `null` (follow global): the chip stays correct
     * for override-less sessions, and a later `session-mode-changed` event
     * refreshes sessions that do carry an override.
     */
    const fetchSessionMode = async (sessionID: string): Promise<void> => {
      try {
        setChip("sessions", sessionID, await api.sessionMode(sessionID))
      } catch {
        setChip("sessions", sessionID, null)
      }
    }

    const bootFetch = async (retriesLeft: number): Promise<void> => {
      if (await fetchMode()) return
      // The server plugin may not be registered yet at TUI boot; retry
      // quietly. Bounded (unlike the sibling plugins' unbounded retry) so the
      // timer loop provably terminates: after the cap the chip stays hidden
      // until the next settings-changed event refreshes it.
      if (retriesLeft > 0) {
        setTimeout(() => void bootFetch(retriesLeft - 1), BOOT_FETCH_RETRY_MS)
      }
    }

    const renderChip = (mode: OperatingMode | null) => {
      if (mode === null) return <text></text>
      const entry = chipFor(mode)
      // The accent-colored span cannot execute in-repo: the terminal renderer
      // cannot start headless and jsdom's HTML parser mangles the intrinsic
      // <text><span> template (null insert parent). The chipFor tests pin the
      // color mapping; the chip render test pins the plain observe shape.
      /* v8 ignore start */
      if (entry.fg === null) return <text>{entry.text}</text>
      return (
        <text>
          <span style={{ fg: entry.fg }}>{entry.text}</span>
        </text>
      )
      /* v8 ignore stop */
    }
    const chipNode = (sessionID: string | undefined) => {
      // On home (no session id) the chip shows the global mode; in a session
      // it shows the session's EFFECTIVE mode (override ?? global).
      if (sessionID === undefined) return renderChip(chip.mode)
      const override = chip.sessions[sessionID]
      if (override === undefined) {
        // First render for this session: fetch the override; the store write
        // re-renders this node with the fetched value. Until then the global
        // mode is shown.
        void fetchSessionMode(sessionID)
        return renderChip(chip.mode)
      }
      return renderChip(override ?? chip.mode)
    }
    // The home footer slot only exists on the home screen; sessions render
    // the prompt footer — its slot input carries the open session's id, so
    // the chip there shows that session's effective mode (ADP-054).
    const disposeSlots = [
      context.ui.slot({ append: "home.footer.status", render: () => chipNode(undefined) }),
      context.ui.slot({
        append: "prompt.footer.status",
        render: (input) => chipNode(input.sessionID),
      }),
    ]

    const disposeWatch = client.events.on("settings-changed", () => {
      void fetchMode()
      // A global mode change re-renders override-less sessions reactively;
      // cached overrides are re-fetched so a stale mirror cannot stick.
      for (const sessionID of Object.keys(chip.sessions)) {
        void fetchSessionMode(sessionID)
      }
    })
    const disposeSessionWatch = client.events.on("session-mode-changed", (event) => {
      // The event data crosses the wire as an untyped record: a malformed
      // payload is ignored (fail-open) instead of steering a bogus session.
      const sessionID = event.data.sessionID
      if (typeof sessionID === "string") void fetchSessionMode(sessionID)
    })

    void bootFetch(BOOT_FETCH_RETRIES)

    return () => {
      for (const dispose of disposeSlots) dispose()
      disposeWatch()
      disposeSessionWatch()
    }
  },
})
