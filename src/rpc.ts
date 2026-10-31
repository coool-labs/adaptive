/**
 * RPC entrypoint: the typed definition shared by the server plugin and the
 * control surfaces, plus the handler binding used server-side.
 */
export { adaptiveRpc, ADAPTIVE_RPC_ID } from "./rpc/definition.js"
export type { AdaptiveRpc } from "./rpc/definition.js"
export { adaptiveRpcHandlers } from "./rpc/handlers.js"
export type { AdaptiveRpcSource, SettingsChangedEmit } from "./rpc/handlers.js"
export { buildStatus } from "./rpc/status.js"
export type { StatusSnapshot, TierResourceStatus } from "./rpc/status.js"
