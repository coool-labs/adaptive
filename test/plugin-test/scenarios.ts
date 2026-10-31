/**
 * Packed-plugin conformance scenarios for `@coool/opencode-plugin-test`.
 *
 * Every scenario runs against a real OpenCode host that loaded the real
 * packed npm artifact of this plugin (packed mode), so what is asserted here
 * is the shipped behavior, not the source checkout.
 *
 * The file is loaded by the plugin-test runner via Node type stripping, so it
 * must stick to erasable TypeScript syntax (no enums, no namespaces).
 */
import { definePluginTestSuite } from "@coool/opencode-plugin-test"

const PLUGIN_ID = "coool.adaptive"

interface RpcOutcome {
  status: number
  body: unknown
  text: string
}

/**
 * POSTs an RPC call against the sandbox host's typed-RPC surface.
 *
 * Verified wire contract (opencode 2.2.5): the request body is a JSON object
 * whose `input` field carries the call input — an absent/undefined input
 * serializes to `{}`; the host validates `body.input` against the registered
 * definition. Successful responses wrap the handler output as `{output}`.
 */
async function callRpc(
  ctx: { request: (path: string, init?: RequestInit) => Promise<RpcOutcome> },
  method: string,
  input: unknown,
): Promise<unknown> {
  const outcome = await ctx.request(`/api/rpc/${PLUGIN_ID}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input }),
  })
  assert(outcome.status === 200, `${method} returned HTTP ${String(outcome.status)}`)
  const body = outcome.body
  if (!isRecord(body)) {
    throw new Error(`${method} returned a non-object body`)
  }
  const { output } = body
  return output
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Narrowing assert: throws with `message` unless `value` is a record. */
function assertRecord(value: unknown, message: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(message)
  }
  return value
}

export default definePluginTestSuite({
  name: PLUGIN_ID,
  scenarios: {
    "plugin activates with the expected id": (ctx) => {
      assert(
        ctx.plugin.state.status === "active",
        `plugin state is not active: ${JSON.stringify(ctx.plugin.state)}`,
      )
      assert(ctx.plugin.id === PLUGIN_ID, `plugin id is ${String(ctx.plugin.id)}`)
      // Setup completing (state "active") implies every registration inside
      // setup succeeded, including the typed escalation tool registration and
      // the session/event hooks — the host fails the plugin otherwise.
      assert(ctx.plugin.features.server === true, "server surface not reported")
      assert(ctx.plugin.features.rpc === true, "rpc surface not reported")
    },
    "typed rpc returns install defaults": async (ctx) => {
      const body = assertRecord(
        await callRpc(ctx, "settings.get", undefined),
        "settings.get returned a non-object output",
      )
      assert(body["version"] === 1, "settings version is not 1")
      assert(body["mode"] === "observe", "fresh install must default to observe mode")
      assert(body["pin"] === null, "fresh install must have no pin")
      assert(body["inviteDismissed"] === false, "fresh install must show the invite")
      assert(isRecord(body["tiers"]), "tiers must be a record")
      for (const tier of ["quick", "standard", "advanced"]) {
        assert(
          Array.isArray((body["tiers"] as Record<string, unknown>)[tier]),
          `tier ${tier} must be an array`,
        )
      }
    },
    "typed rpc applies a settings patch": async (ctx) => {
      const set = assertRecord(
        await callRpc(ctx, "settings.set", { mode: "control" }),
        "settings.set returned a non-object output",
      )
      assert(set["ok"] === true, "valid patch must apply")
      const settings = assertRecord(set["settings"], "applied settings must be a record")
      assert(settings["mode"] === "control", "applied settings must report the new mode")
      const invalid = assertRecord(
        await callRpc(ctx, "settings.set", { mode: "bogus" }),
        "invalid patch returned a non-object output",
      )
      assert(invalid["ok"] === false, "invalid patch must be rejected with ok:false")
      const get = assertRecord(
        await callRpc(ctx, "settings.get", undefined),
        "settings.get returned a non-object output",
      )
      assert(get["mode"] === "control", "settings.get must reflect the applied patch")
    },
    "typed rpc status mirrors settings": async (ctx) => {
      const body = assertRecord(
        await callRpc(ctx, "status.get", undefined),
        "status.get returned a non-object output",
      )
      assert(body["mode"] === "control", "status must mirror the applied mode")
      assert(isRecord(body["tiers"]), "status tiers must be a record")
      for (const tier of ["quick", "standard", "advanced"]) {
        assert(
          Array.isArray((body["tiers"] as Record<string, unknown>)[tier]),
          `status tier ${tier} must be an array`,
        )
      }
      assert(
        typeof body["parked"] === "number" && typeof body["receipts"] === "number",
        "parked/receipts counts must be numbers",
      )
    },
    "typed rpc receipts.list starts empty": async (ctx) => {
      const output = await callRpc(ctx, "receipts.list", undefined)
      assert(Array.isArray(output), "receipts.list must return a receipts array")
    },
    "unknown rpc method is rejected": async (ctx) => {
      const outcome = await ctx.request(`/api/rpc/${PLUGIN_ID}/does-not-exist`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: {} }),
      })
      assert(outcome.status !== 200, "unknown rpc method must not succeed")
    },
    "host session apis remain available": async (ctx) => {
      // ADP-025: installing Adaptive must leave ordinary OpenCode behavior
      // intact — a plain session can be created through the public API.
      const created = await ctx.request("/api/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      })
      assert(created.status === 200, `session create returned HTTP ${String(created.status)}`)
      assert(isRecord(created.body), "session create returned a non-object body")
    },
  },
})
