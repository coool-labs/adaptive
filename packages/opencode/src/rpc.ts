/**
 * RPC entrypoint: the typed definition shared by the server plugin and the
 * control surfaces, plus the handler binding used server-side.
 */
export { adaptiveRpc, ADAPTIVE_RPC_ID } from "./rpc/definition.js"
export type { AdaptiveRpc } from "./rpc/definition.js"
export { adaptiveRpcHandlers } from "./rpc/handlers.js"
export type {
  AdaptiveRpcSource,
  AdaptiveRpcEmit,
  SettingsChangedEmit,
  TierRequestSetResult,
} from "./rpc/handlers.js"
export { buildStatus } from "@coool/adaptive-core/status"
export type { StatusSnapshot, TierResourceStatus } from "@coool/adaptive-core/status"
