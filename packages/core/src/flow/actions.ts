/**
 * Local operations behind the `/adaptive` menu and subcommands (ADP-062):
 * health reset, parked work and the doctor report. Hosts wire only what they
 * support; the dialogs and outcome copy live here so every host reads alike.
 */
import type { ModelRef } from "../routing/work-unit/types.js"
import type { TierResourceStatus } from "../status.js"
import type { AdaptiveEnv } from "./controller.js"
import { doctorLines, type DoctorCheck } from "./doctor.js"
import { healthEntries, STATUS_EMPTY_MESSAGE, stateCell } from "./status.js"
import { resourceLabel } from "./tiers.js"
import { waitingLabel } from "./waiting.js"

/** `waiting`: a manual resume found the tier still unavailable and stays parked. */
export type ResumeOutcome = "resumed" | "waiting" | "not-parked"
export type CancelOutcome = "cancelled" | "not-parked"

export interface AdaptiveActions {
  /** Mark a model healthy again, with its inherited provider limits. */
  readonly resetHealth?: (model: ModelRef) => Promise<void>
  /** Try the session's parked work now, bypassing the automatic give-up budget. */
  readonly resume?: (sessionID: string) => Promise<ResumeOutcome>
  /** Drop the session's wait and parked record. */
  readonly cancel?: (sessionID: string) => Promise<CancelOutcome>
  /** Declare which models can call tools, where the host catalog does not say. */
  readonly tools?: () => Promise<void>
  readonly doctor?: () => Promise<readonly DoctorCheck[]>
  readonly preferences?: () => Promise<void>
  readonly defaults?: () => Promise<void>
}

const PARKED_TITLE = "Parked work"
const NOTHING_PARKED = "Nothing is parked in this session."
const OPEN_SESSION = "Open the waiting session and run /adaptive there to resume or cancel it."

/** Pick a configured model, confirm, reset. Lists each model once, with its state. */
export async function runHealthReset(
  env: AdaptiveEnv,
  reset: (model: ModelRef) => Promise<void>,
): Promise<void> {
  const snapshot = await env.api.status()
  const models = new Map<string, TierResourceStatus>()
  for (const { status } of healthEntries(snapshot)) models.set(resourceLabel(status.ref), status)
  if (models.size === 0) {
    await env.view.alert({ title: "Health", message: STATUS_EMPTY_MESSAGE })
    return
  }
  const model = await env.view.select({
    title: "Health · select a model to reset",
    options: [...models].map(([label, status]) => {
      const state = stateCell(status, snapshot.pin)
      return {
        title: label,
        value: status.ref,
        description: state === "-" ? status.health : `${status.health} · ${state}`,
      }
    }),
  })
  if (model === undefined) return
  const label = resourceLabel(model)
  const confirmed = await env.view.confirm({
    title: "Reset model health?",
    message: `Reset ${label} and its inherited provider limits? Other models on this provider may be affected. This does not restore actual provider quota.`,
  })
  if (confirmed !== true) return
  await reset(model)
  env.view.toast("Health reset", "success")
}

/** Resume this session's parked work. True when the run continues and the menu should close. */
export async function resumeHere(
  env: AdaptiveEnv,
  resume: (sessionID: string) => Promise<ResumeOutcome>,
): Promise<boolean> {
  if (env.sessionID === undefined) {
    await env.view.alert({ title: PARKED_TITLE, message: OPEN_SESSION })
    return false
  }
  const outcome = await resume(env.sessionID)
  switch (outcome) {
    case "resumed":
      env.view.toast("Resuming parked work", "success")
      return true
    case "waiting":
      await env.view.alert({
        title: PARKED_TITLE,
        message: "No model in this tier is available yet. Adaptive keeps waiting and retries.",
      })
      return false
    case "not-parked":
      await env.view.alert({ title: PARKED_TITLE, message: NOTHING_PARKED })
      return false
  }
}

/** Drop this session's parked work. */
export async function cancelHere(
  env: AdaptiveEnv,
  cancel: (sessionID: string) => Promise<CancelOutcome>,
): Promise<void> {
  if (env.sessionID === undefined) {
    await env.view.alert({ title: PARKED_TITLE, message: OPEN_SESSION })
    return
  }
  if ((await cancel(env.sessionID)) === "cancelled")
    env.view.toast("Parked work cancelled", "success")
  else await env.view.alert({ title: PARKED_TITLE, message: NOTHING_PARKED })
}

/**
 * Waiting sessions, then what to do with this session's wait. Other sessions
 * are listed but act only from inside: a host can only continue the session
 * it runs in. True when a resumed run continues and the menu should close.
 */
export async function runParkedWork(env: AdaptiveEnv, actions: AdaptiveActions): Promise<boolean> {
  const { waiting } = await env.api.status()
  if (waiting.length === 0) {
    await env.view.alert({ title: PARKED_TITLE, message: "No parked work." })
    return false
  }
  const now = (env.clock ?? Date.now)()
  const picked = await env.view.select({
    title: PARKED_TITLE,
    options: waiting.map((entry) => ({
      title: entry.sessionID === env.sessionID ? "This session" : entry.sessionID,
      value: entry.sessionID,
      description: `${entry.tier} · ${waitingLabel(entry.resumeAt, now)}`,
    })),
  })
  if (picked === undefined) return false
  if (picked !== env.sessionID) {
    await env.view.alert({ title: PARKED_TITLE, message: OPEN_SESSION })
    return false
  }
  const { resume, cancel } = actions
  const run = await env.view.select<() => Promise<boolean>>({
    title: "This session's parked work",
    options: [
      ...(resume === undefined
        ? []
        : [
            {
              title: "Resume now",
              value: () => resumeHere(env, resume),
              description: "try the tier again",
            },
          ]),
      ...(cancel === undefined
        ? []
        : [
            {
              title: "Cancel",
              value: async () => {
                await cancelHere(env, cancel)
                return false
              },
              description: "drop the wait; your next prompt starts fresh",
            },
          ]),
    ],
  })
  return run === undefined ? false : run()
}

export async function runDoctor(
  env: AdaptiveEnv,
  doctor: () => Promise<readonly DoctorCheck[]>,
): Promise<void> {
  await env.view.table({ title: "Adaptive doctor", lines: doctorLines(await doctor()) })
}
