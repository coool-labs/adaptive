/**
 * Durable settings (ADP-036): versioned, migrated on read, persisted through
 * `ctx.storage` under a single key. The server plugin owns the store; TUI and
 * GUI surfaces only read snapshots and send patches (ADP-034/036).
 */
import type { OperatingMode } from "../../core/scheduler/types.js"
import type { TierName } from "../../core/tier-policy/types.js"
import type { ModelRef } from "../../core/work-unit/types.js"

/** Storage key for the settings record (see architecture "Persistence ownership"). */
export const SETTINGS_KEY = "coool.adaptive/settings"

/** Current settings schema version. */
export const SETTINGS_VERSION = 1

/**
 * Product bounds, not user knobs: they keep a hostile or buggy write from
 * growing state without limit. (Patch error lists need no cap: at most one
 * error per field, and the patch has five fields.)
 */
export const MAX_TIER_RESOURCES = 32
export const MAX_AGENT_TIERS = 64

export interface SettingsV1 {
  readonly version: typeof SETTINGS_VERSION
  /** OFF does nothing; OBSERVE is the safe default after install (ADP-029/032). */
  readonly mode: OperatingMode
  /** Ordered per-tier resource lists; order is user policy and never reordered (ADP-005). */
  readonly tiers: Readonly<Record<TierName, readonly ModelRef[]>>
  /**
   * Global explicit user pin. `null` = no pin. A pin names a concrete model
   * and outranks every other routing input (ADP-002).
   */
  readonly pin: ModelRef | null
  /** User-configured agent → tier hints (role level of the ladder, ADP-002). */
  readonly agentTiers: Readonly<Record<string, TierName>>
  /** First-install invitation dismissed (ADP-032: shown once, never nagged). */
  readonly inviteDismissed: boolean
}

/**
 * Partial update as sent by surfaces over RPC. Field absence means "leave
 * unchanged"; `pin: null` explicitly clears the pin.
 */
export interface SettingsPatch {
  readonly mode?: OperatingMode | undefined
  readonly tiers?: Readonly<Record<TierName, readonly ModelRef[]>> | undefined
  readonly pin?: ModelRef | null | undefined
  readonly agentTiers?: Readonly<Record<string, TierName>> | undefined
  readonly inviteDismissed?: boolean | undefined
}

export type PatchResult =
  | { readonly ok: true; readonly settings: SettingsV1 }
  | {
      readonly ok: false
      readonly errors: readonly string[]
    }

/**
 * Narrow storage seam so the store stays decoupled from `@opencode/plugin`
 * (only `adapters/opencode` may touch the host API). The adapter binds the
 * settings key and translates `ctx.storage`.
 */
export interface SettingsStorage {
  read(): Promise<unknown>
  write(settings: SettingsV1): Promise<void>
}
