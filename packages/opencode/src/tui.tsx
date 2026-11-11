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
import { TextAttributes } from "@opentui/core"
import { createStore, reconcile } from "solid-js/store"
import { PLUGIN_ID } from "./plugin-id.js"
import { adaptiveRpc } from "./rpc/definition.js"
import type { OperatingMode } from "@coool/adaptive-core/routing/scheduler/types"
import { TIERS } from "@coool/adaptive-core/routing/tier-policy/types"
import { parseMode } from "@coool/adaptive-core/state/settings/index"
import { OPENCODE_COPY } from "./ui/copy.js"
import { runAdaptive } from "@coool/adaptive-core/flow/controller"
import type { AdaptiveApi, AdaptiveView } from "@coool/adaptive-core/flow/controller"
import { errorText } from "@coool/adaptive-core/flow/options"
import type { ModelSummary } from "@coool/adaptive-core/flow/tiers"
import { WAITING_POLL_MS, waitingLabel, waitingSessions } from "@coool/adaptive-core/flow/waiting"
import { matchOptions } from "./ui/tui/search.js"

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

/** A parked session's chip (ADP-024): amber like any pending state, with when it resumes. */
export function waitingChip(resumeAt: number | null, now: number): Chip {
  return { text: `Adaptive · ${waitingLabel(resumeAt, now)}`, fg: "#e5c07b" }
}

/**
 * The unconfigured chip: no tier has a model, so Adaptive cannot route anything.
 * Amber like the other "needs your action" states; naming the command is the hint.
 */
export function setupChip(): Chip {
  return { text: "Adaptive · run /adaptive to set up", fg: "#e5c07b" }
}

/**
 * The prompt footer chip for one session: parked work waiting for quota wins
 * over everything; a session (or home) whose effective mode is unknown shows
 * nothing; then the setup hint while nothing is configured; then the session's
 * override, then the global mode (ADP-054). `override` is undefined until
 * fetched; null means "follows global". `configured` is undefined until
 * the first status read lands.
 */
export function sessionChip(state: {
  mode: OperatingMode | null
  override: OperatingMode | null | undefined
  resumeAt: number | null | undefined
  configured: boolean | undefined
  now: number
}): Chip | null {
  if (state.resumeAt !== undefined) return waitingChip(state.resumeAt, state.now)
  const mode = state.override ?? state.mode
  if (mode === null) return null
  if (state.configured === false) return setupChip()
  return chipFor(mode)
}

const BOOT_FETCH_RETRIES = 5
const BOOT_FETCH_RETRY_MS = 2000

export default define({
  id: PLUGIN_ID,
  setup(context: Context) {
    const client = context.client.rpc(adaptiveRpc)
    // RPC handlers resolve per location: a location-less call never reaches a
    // project-local plugin's handlers ("RPC is unavailable", verified live in
    // the sibling @coool plugins), so every call carries the TUI's location.
    const at = () => ({ location: context.location })
    const api: AdaptiveApi = {
      settings: () => client["settings.get"](undefined, at()),
      setSettings: (patch) => client["settings.set"](patch, at()),
      status: () => client["status.get"](undefined, at()),
      receipts: () => client["receipts.list"](undefined, at()),
      sessionMode: (sessionID) =>
        client["session-mode.get"]({ sessionID }, at()).then((out) => out.mode),
      setSessionMode: (sessionID, mode) => client["session-mode.set"]({ sessionID, mode }, at()),
      tierRequest: (sessionID) =>
        client["tier-request.get"]({ sessionID }, at()).then((out) => out.tier),
      setTierRequest: (sessionID, tier) => client["tier-request.set"]({ sessionID, tier }, at()),
    }
    const view: AdaptiveView = {
      // A placeholder marks a searchable list (the model picker).
      select: (options) =>
        context.ui.dialog.select(
          options.placeholder === undefined ? options : { ...options, search: matchOptions },
        ),
      selectPaged: <Value,>(spec: {
        title: string
        options: readonly { title: string; value: Value }[]
        actions: readonly { title: string; value: string; bind: string }[]
      }) =>
        // Footer actions flip pages: triggering one closes the dialog and
        // resolves with the action instead of a pick; the controller loop
        // then reopens the browser at the new offset. The host resolves its
        // own select promise undefined on the clear() — resolving our
        // promise first-come means the action result wins.
        new Promise<{ picked: Value | undefined; action: string | undefined }>(
          (resolve, reject) => {
            void context.ui.dialog
              .select({
                title: spec.title,
                options: spec.options,
                actions: spec.actions.map((action) => ({
                  bind: action.bind,
                  title: action.title,
                  selection: "none" as const,
                  onTrigger: () => {
                    context.ui.dialog.clear()
                    resolve({ picked: undefined, action: action.value })
                  },
                })),
              })
              .then((picked) => {
                resolve({ picked, action: undefined })
              }, reject)
          },
        ),
      confirm: (options) => context.ui.dialog.confirm(options),
      alert: (options) => context.ui.dialog.alert(options),
      table: (spec) =>
        // The host has no table dialog; a custom dialog render gives the
        // column grid its own layout. The default dialog size is too narrow
        // for the column grid (rows wrap mid-token), so the dialog is
        // widened to xlarge right after it opens. Escape closes the dialog
        // and fires onClose, which resolves the view promise.
        new Promise<void>((resolve) => {
          context.ui.dialog.show(
            () => (
              // Styled to match the host's own dialogs (bold title, dim esc
              // hint). The host dialog panel already insets the content, so
              // the box adds no top padding of its own; a blank spacer row
              // separates the title row from the table.
              <box style={{ flexDirection: "column", paddingBottom: 1, paddingX: 2 }}>
                <box style={{ flexDirection: "row", justifyContent: "space-between" }}>
                  <text style={{ attributes: TextAttributes.BOLD }}>{spec.title}</text>
                  <text style={{ attributes: TextAttributes.DIM }}>esc</text>
                </box>
                <text> </text>
                {spec.lines.map((line) => (
                  <text>{line}</text>
                ))}
              </box>
            ),
            () => {
              resolve()
            },
          )
          context.ui.dialog.set({ size: "xlarge" })
        }),
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
          // No `arguments`: the host only inserts an argument command into the
          // prompt and runs it on the submit key, so with Enter bound to
          // newline (submit on ctrl+return) picking /adaptive did nothing.
          // Without it, picking the entry opens the menu, like the GUI.
          slash: { name: "adaptive" },
          run: () => {
            // Inside a session the flows steer that session's mode override
            // (ADP-054); on home they patch the global mode.
            const current = context.ui.router.current()
            const sessionID = current.type === "session" ? current.sessionID : undefined
            void runAdaptive({
              copy: OPENCODE_COPY,
              api,
              view,
              models,
              clock: Date.now,
              actions: {
                resetHealth: (model) => client["health.reset"](model, at()),
                resume: (sessionID) => client["parked.resume"]({ sessionID }, at()),
                cancel: (sessionID) => client["parked.cancel"]({ sessionID }, at()),
                doctor: () => client["doctor.run"](undefined, at()),
              },
              ...(sessionID !== undefined ? { sessionID } : {}),
            }).catch((error: unknown) => {
              view.toast(errorText(error), "error")
            })
          },
        },
      ],
    }))

    // Footer chip state: a reactive mirror of the server's operating mode,
    // fetched once at boot and kept live via the settings-changed event, the
    // per-session overrides seen so far (ADP-054), and the sessions parked
    // until quota returns (ADP-024) with the clock they were read at.
    const [chip, setChip] = createStore<{
      mode: OperatingMode | null
      sessions: Record<string, OperatingMode | null>
      waiting: Record<string, number | null>
      /** Any tier has a model; undefined until the first status read lands. */
      configured: boolean | undefined
      now: number
    }>({ mode: null, sessions: {}, waiting: {}, configured: undefined, now: Date.now() })

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

    /**
     * Parked sessions come from the status snapshot. Work parks and resumes
     * without any TUI action (a failed execution, the server's wake timer),
     * so the chip polls; a failed read keeps the last known state.
     */
    let waitingReads = 0
    const fetchWaiting = async (): Promise<void> => {
      // A poll and an event-driven read can overlap: only the latest lands.
      waitingReads += 1
      const read = waitingReads
      try {
        const snapshot = await api.status()
        const sessions = waitingSessions(snapshot)
        if (read !== waitingReads) return
        setChip("waiting", reconcile(sessions))
        setChip(
          "configured",
          TIERS.some((tier) => snapshot.tiers[tier].length > 0),
        )
        setChip("now", Date.now())
      } catch {
        // Keep the last known state until the next poll.
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

    const renderChip = (entry: Chip | null) => {
      if (entry === null) return <text></text>
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
      // On home (no session id) the chip shows the setup hint, then the global
      // mode; in a session it shows the session's wait or EFFECTIVE mode
      // (override ?? global), with the same setup hint when unconfigured.
      if (sessionID === undefined)
        return renderChip(
          sessionChip({
            mode: chip.mode,
            override: undefined,
            resumeAt: undefined,
            configured: chip.configured,
            now: chip.now,
          }),
        )
      const override = chip.sessions[sessionID]
      // First render for this session: fetch the override; the store write
      // re-renders this node with the fetched value. Until then the global
      // mode is shown.
      if (override === undefined) void fetchSessionMode(sessionID)
      return renderChip(
        sessionChip({
          mode: chip.mode,
          override,
          resumeAt: chip.waiting[sessionID],
          configured: chip.configured,
          now: chip.now,
        }),
      )
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
      // Only active sessions wait: a mode change can start or end a wait.
      void fetchWaiting()
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
      void fetchWaiting()
    })

    void bootFetch(BOOT_FETCH_RETRIES)
    void fetchWaiting()
    const waitingPoll = setInterval(() => void fetchWaiting(), WAITING_POLL_MS)

    return () => {
      for (const dispose of disposeSlots) dispose()
      disposeWatch()
      disposeSessionWatch()
      clearInterval(waitingPoll)
    }
  },
})
