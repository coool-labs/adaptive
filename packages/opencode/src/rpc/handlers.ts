/**
 * RPC handler binding (ADP-034/036): adapts the supervisor's state API to the
 * typed RPC methods. Handlers never throw for expected outcomes — an invalid
 * patch is a per-field `PatchResult`, and an internal failure degrades to
 * `{ ok: false }` (fail-open, ADP-031). Read methods declare internal failures
 * through the call context's error factory: a plain throw becomes a server
 * defect whose generic `rpc.internal` message hides the cause (verified on the
 * sibling @coool plugins).
 */
import { OPERATING_MODES } from "@coool/adaptive-core/routing/scheduler/types"
import type { OperatingMode } from "@coool/adaptive-core/routing/scheduler/types"
import { TIERS } from "@coool/adaptive-core/routing/tier-policy/types"
import type { TierName } from "@coool/adaptive-core/routing/tier-policy/types"
import { LOG_ERROR_LENGTH, logFailOpen } from "@coool/adaptive-core/log"
import { isValidSessionID } from "@coool/adaptive-core/state/session-modes/index"
import type { PatchResult } from "@coool/adaptive-core/state/settings/types"
import type { SettingsPatch, SettingsV1 } from "@coool/adaptive-core/state/settings/index"
import type { Rpc } from "@opencode/schema/rpc"
import type { Receipt } from "@coool/adaptive-core/state/receipts/types"
import type { StatusSnapshot } from "@coool/adaptive-core/status"
import type { AdaptiveRpc } from "./definition.js"
import type { ModelRef } from "@coool/adaptive-core/routing/work-unit/types"
import type { ResumeOutcome, CancelOutcome } from "@coool/adaptive-core/flow/actions"
import type { DoctorCheck } from "@coool/adaptive-core/flow/doctor"

export interface AdaptiveRpcSource {
  resetHealth(model: ModelRef): Promise<void>
  resumeParked(sessionID: string): Promise<ResumeOutcome>
  cancelParked(sessionID: string): Promise<CancelOutcome>
  doctor(): Promise<DoctorCheck[]>
  settings(): Promise<SettingsV1>
  updateSettings(patch: SettingsPatch): Promise<PatchResult>
  status(): Promise<StatusSnapshot>
  receipts(): Promise<Receipt[]>
  getSessionMode(sessionID: string): Promise<OperatingMode | null>
  setSessionMode(sessionID: string, mode: OperatingMode | null): Promise<void>
  getTierRequest(sessionID: string): Promise<TierName | null>
  noteTierRequest(sessionID: string, tier: string): boolean
  setTierRequest(sessionID: string, tier: TierName | null): Promise<void>
}

export type SettingsChangedEmit = (name: "settings-changed", data: { version: number }) => unknown

/**
 * Correlated emit: each call site pairs the event name with its own payload
 * shape — an invalid pairing is a type error, and the registration site can
 * forward the tuple to the host emitter untouched.
 */
export type AdaptiveRpcEmit = (
  ...args:
    | ["settings-changed", { version: number }]
    | ["session-mode-changed", { sessionID: string }]
    | ["tier-request-changed", { sessionID: string }]
) => unknown

export type { TierRequestSetResult } from "@coool/adaptive-core/state/tier-requests/types"

/** Per-field errors for a session-mode patch, mirroring the settings contract. */
function sessionModeSetError(input: {
  sessionID: string
  mode: OperatingMode | null
}): string | undefined {
  if (!isValidSessionID(input.sessionID)) {
    return "sessionID must be a non-empty string of at most 128 characters"
  }
  if (input.mode !== null && !(OPERATING_MODES as readonly string[]).includes(input.mode)) {
    return `mode must be one of ${OPERATING_MODES.join(", ")} or null`
  }
  return undefined
}

/** Same contract for a tier-request patch (ADP-055): vocabulary-gated tier. */
function tierRequestSetError(input: {
  sessionID: string
  tier: string | null
}): string | undefined {
  if (!isValidSessionID(input.sessionID)) {
    return "sessionID must be a non-empty string of at most 128 characters"
  }
  if (input.tier !== null && !(TIERS as readonly string[]).includes(input.tier)) {
    return `tier must be one of ${TIERS.join(", ")} or null`
  }
  return undefined
}

type Methods = AdaptiveRpc["methods"]
type MethodName = Extract<keyof Methods, string>

/** The subset of the host's RpcCallContext the handlers use (no plugin import). */
export interface AdaptiveRpcCallContext<Name extends MethodName> {
  readonly error: Rpc.ErrorFactory<Methods[Name]>
}

type HandlerErrorOf<Name extends MethodName> = Rpc.HandlerError<Methods[Name]>

type HandlerOf<Name extends MethodName> = (
  input: Rpc.Output<Methods[Name]["input"]>,
  context: AdaptiveRpcCallContext<Name>,
) => Promise<Rpc.HandlerOutput<Methods[Name]["output"]> | HandlerErrorOf<Name>>

/**
 * One settings write for every surface (RPC and the web command): persist,
 * then announce so open views refresh. An internal failure degrades to an
 * error result (fail-open, ADP-031).
 */
export async function patchSettings(
  source: Pick<AdaptiveRpcSource, "updateSettings">,
  emit: AdaptiveRpcEmit | undefined,
  patch: SettingsPatch,
): Promise<PatchResult> {
  try {
    const result = await source.updateSettings(patch)
    if (result.ok && emit !== undefined) {
      try {
        await emit("settings-changed", { version: result.settings.version })
      } catch (error) {
        logFailOpen("rpc-emit", error)
      }
    }
    return result
  } catch (error) {
    logFailOpen("rpc-set", error)
    return { ok: false, errors: ["internal error"] }
  }
}

export function adaptiveRpcHandlers(
  source: AdaptiveRpcSource,
  emit?: AdaptiveRpcEmit,
): { [Name in MethodName]: HandlerOf<Name> } {
  return {
    "health.reset": (model, context) =>
      source
        .resetHealth(model)
        .then(() => undefined)
        .catch(() =>
          context.error("internal", "Health could not be reset. Check Adaptive storage."),
        ),
    "parked.resume": (input, context) =>
      source
        .resumeParked(input.sessionID)
        .catch((error: unknown) =>
          context.error("internal", String(error).slice(0, LOG_ERROR_LENGTH)),
        ),
    "parked.cancel": (input, context) =>
      source
        .cancelParked(input.sessionID)
        .catch(() =>
          context.error("internal", "Parked work could not be cancelled. Check Adaptive storage."),
        ),
    "doctor.run": (_input, context) =>
      source
        .doctor()
        .catch(() => context.error("internal", "Adaptive doctor could not read the setup.")),
    "settings.get": (_input, context) =>
      source
        .settings()
        .catch((error: unknown) =>
          context.error("internal", String(error).slice(0, LOG_ERROR_LENGTH)),
        ),
    "settings.set": (patch) => patchSettings(source, emit, patch),
    "status.get": (_input, context) =>
      source
        .status()
        .catch((error: unknown) =>
          context.error("internal", String(error).slice(0, LOG_ERROR_LENGTH)),
        ),
    "receipts.list": (_input, context) =>
      source
        .receipts()
        .catch((error: unknown) =>
          context.error("internal", String(error).slice(0, LOG_ERROR_LENGTH)),
        ),
    "session-mode.get": (input, context) =>
      source
        .getSessionMode(input.sessionID)
        .then((mode) => ({ mode }))
        .catch((error: unknown) =>
          context.error("internal", String(error).slice(0, LOG_ERROR_LENGTH)),
        ),
    "session-mode.set": async (input) => {
      const invalid = sessionModeSetError(input)
      if (invalid !== undefined) return { ok: false, errors: [invalid] }
      try {
        await source.setSessionMode(input.sessionID, input.mode)
      } catch (error) {
        logFailOpen("rpc-set", error)
        return { ok: false, errors: ["internal error"] }
      }
      if (emit !== undefined) {
        try {
          await emit("session-mode-changed", { sessionID: input.sessionID })
        } catch (error) {
          logFailOpen("rpc-emit", error)
        }
      }
      return { ok: true }
    },
    "tier-request.get": (input, context) =>
      source
        .getTierRequest(input.sessionID)
        .then((tier) => ({ tier }))
        .catch((error: unknown) =>
          context.error("internal", String(error).slice(0, LOG_ERROR_LENGTH)),
        ),
    "tier-request.set": async (input) => {
      const invalid = tierRequestSetError(input)
      if (invalid !== undefined) return { ok: false, errors: [invalid] }
      if (input.tier !== null) {
        // A non-null tier is a sticky record: noteTierRequest re-validates the
        // vocabulary (post-gate this cannot fail, so treat `false` as internal).
        if (!source.noteTierRequest(input.sessionID, input.tier)) {
          logFailOpen("rpc-set", new Error("tier request rejected"))
          return { ok: false, errors: ["internal error"] }
        }
      } else {
        try {
          await source.setTierRequest(input.sessionID, null)
        } catch (error) {
          logFailOpen("rpc-set", error)
          return { ok: false, errors: ["internal error"] }
        }
      }
      if (emit !== undefined) {
        try {
          await emit("tier-request-changed", { sessionID: input.sessionID })
        } catch (error) {
          logFailOpen("rpc-emit", error)
        }
      }
      return { ok: true }
    },
  }
}
