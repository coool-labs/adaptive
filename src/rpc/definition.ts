/**
 * Typed RPC definition (ADP-034/036): the only channel between the server
 * plugin and the TUI/GUI surfaces. Surfaces hold no local settings state —
 * they fetch snapshots, patch settings, and re-fetch on the `settings-changed`
 * event (the server is the single source of truth).
 *
 * Schema note: input schemas gate the wire shape (non-object patches are
 * rejected as rpc.invalid_input); deeper validation happens in the handlers
 * via the state parsers (`applyPatch` reports per-field errors instead), and
 * output schemas are passthroughs over trusted server-side data.
 */
import { Rpc } from "@opencode/schema/rpc"
import type { StandardSchemaV1 } from "@standard-schema/spec"
import type { SettingsPatch, SettingsV1 } from "../state/settings/index.js"
import type { PatchResult } from "../state/settings/types.js"
import type { Receipt } from "../state/receipts/types.js"
import type { StatusSnapshot } from "./status.js"

export const ADAPTIVE_RPC_ID = "coool.adaptive"
const RPC_VENDOR = "coool.adaptive"

/**
 * Identity schema: the wire value passes through unchanged; the type
 * parameters carry the transport contract. `gate` optionally rejects values
 * before they reach a handler; the failure message names the expectation so a
 * rejected call is diagnosable from the wire error alone.
 */
function schema<T>(gate: (value: unknown) => boolean, expectation: string): StandardSchemaV1<T, T> {
  return {
    "~standard": {
      version: 1,
      vendor: RPC_VENDOR,
      validate: (value) =>
        gate(value) ? { value: value as T } : { issues: [{ message: expectation }] },
    },
  }
}

function voidSchema(): StandardSchemaV1<undefined, undefined> {
  return {
    "~standard": {
      version: 1,
      vendor: RPC_VENDOR,
      validate: (value) =>
        value === undefined
          ? { value: undefined }
          : { issues: [{ message: "unexpected input: no input expected" }] },
    },
  }
}

const isRecord = (value: unknown): boolean =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const adaptiveRpc = Rpc.define({
  id: ADAPTIVE_RPC_ID,
  methods: {
    "settings.get": {
      input: voidSchema(),
      output: schema<SettingsV1>(isRecord, "output must be an object"),
    },
    "settings.set": {
      input: schema<SettingsPatch>(isRecord, "input must be an object"),
      output: schema<PatchResult>(isRecord, "output must be an object"),
    },
    "status.get": {
      input: voidSchema(),
      output: schema<StatusSnapshot>(isRecord, "output must be an object"),
    },
    "receipts.list": {
      input: voidSchema(),
      output: schema<Receipt[]>(Array.isArray, "output must be an array"),
    },
  },
  events: {
    "settings-changed": {
      schema: schema<{ version: number }>(isRecord, "event data must be an object"),
    },
  },
})

export type AdaptiveRpc = typeof adaptiveRpc
