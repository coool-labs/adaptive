import type { LocationRef } from "@opencode/client/promise"
import type { Context } from "@opencode/plugin/gui"
import { onCleanup } from "solid-js"
import type { JSX } from "solid-js"

import { adaptiveRpc } from "../../rpc.js"
import { runAdaptive } from "../flow/controller.js"
import type { AdaptiveApi, AdaptiveView } from "../flow/controller.js"
import { errorText } from "../flow/options.js"
import type { ModelSummary } from "../flow/tiers.js"

/** The slice of the GUI host the shared `/adaptive` flow runs on. */
export type FlowHost = Pick<Context, "client" | "dialogs" | "toast" | "sessions" | "servers" | "ui">

type PagedChoice<Value> =
  | { readonly kind: "pick"; readonly value: Value }
  | { readonly kind: "action"; readonly value: string }

function TableDialog(props: {
  host: FlowHost
  title: string
  lines: readonly string[]
  close: () => void
  done: () => void
}): JSX.Element {
  // Escape and outside clicks close the dialog without telling the opener;
  // unmounting is the one signal that always fires.
  onCleanup(props.done)
  return (
    <props.host.ui.Dialog
      title={props.title}
      size="x-large"
      footer={<props.host.ui.Button onClick={props.close}>Close</props.host.ui.Button>}
    >
      <pre class="adaptive-table">{props.lines.join("\n")}</pre>
    </props.host.ui.Dialog>
  )
}

/**
 * Dialog view over the host's own dialogs. The host select filters on title
 * and description itself, so the model picker needs no search callback, and
 * page flips are ordinary rows because its list has no footer actions.
 */
export function guiView(host: FlowHost): AdaptiveView {
  return {
    select: ({ title, placeholder, options }) =>
      host.dialogs.select({
        title,
        options,
        ...(placeholder !== undefined ? { placeholder } : {}),
      }),
    selectPaged: async (spec) => {
      const choice = await host.dialogs.select<PagedChoice<(typeof spec.options)[number]["value"]>>(
        {
          title: spec.title,
          options: [
            ...spec.options.map((option) => ({
              title: option.title,
              value: { kind: "pick" as const, value: option.value },
            })),
            ...spec.actions.map((action) => ({
              title: action.title,
              value: { kind: "action" as const, value: action.value },
            })),
          ],
        },
      )
      if (choice === undefined) return { picked: undefined, action: undefined }
      return choice.kind === "pick"
        ? { picked: choice.value, action: undefined }
        : { picked: undefined, action: choice.value }
    },
    confirm: ({ title, message }) => host.dialogs.confirm({ title, description: message }),
    alert: ({ title, message }) => host.dialogs.alert({ title, description: message }),
    table: ({ title, lines }) =>
      new Promise<void>((resolve) => {
        host.dialogs.open((dialog) => (
          <TableDialog
            host={host}
            title={title}
            lines={lines}
            close={() => {
              dialog.close()
            }}
            done={resolve}
          />
        ))
      }),
    toast: (message, variant) => {
      host.toast.show({ title: message, variant })
    },
  }
}

/**
 * The session the flow steers: the mounted one, when the plugin's server owns
 * it (Adaptive only knows sessions of the server it runs on).
 */
function ownSession(host: FlowHost): ReturnType<FlowHost["sessions"]["current"]> {
  const session = host.sessions.current()
  return session?.server.builtin === true ? session : undefined
}

/**
 * Typed RPC for the flow. RPC handlers resolve per location, so calls carry
 * the session's directory; on Home there is none and the host default applies.
 */
export function guiFlowApi(host: FlowHost): AdaptiveApi {
  const client = host.client.rpc(adaptiveRpc)
  const at = () => {
    const directory = ownSession(host)?.location?.directory
    return directory === undefined ? {} : { location: { directory } }
  }
  return {
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
}

/**
 * The model catalog slice the picker reads. Declared here because the host's `Data` type does not resolve in this
 * package (its `@opencode/client/solid` types sit behind an unreachable export condition), so it reaches us as `any`.
 */
interface ModelCatalog {
  sync(ref?: LocationRef): Promise<void>
  list(ref?: LocationRef):
    | readonly {
        providerID: string
        modelID: string
        name: string
        variants: readonly { id: string }[]
      }[]
    | undefined
}

function modelData(host: FlowHost): ModelCatalog | undefined {
  const server = host.servers
    .list()
    .map((id) => host.servers.get(id))
    .find((candidate) => candidate?.builtin === true)
  if (server === undefined) return undefined
  // `Data` reaches us as `any` (see ModelCatalog); this is the one place the
  // host shape is asserted, and the flow tests drive it through a fake host.
  const data: unknown = server.data
  return (data as { location: { model: ModelCatalog } }).location.model
}

/** Runs the `/adaptive` flow, the same controller the TUI drives. */
export async function openAdaptive(host: FlowHost): Promise<void> {
  const view = guiView(host)
  const session = ownSession(host)
  const models = modelData(host)
  const run = async (): Promise<void> => {
    // The host loads models lazily; the picker needs them before it opens.
    await models?.sync(session?.location).catch(() => undefined)
    await runAdaptive({
      api: guiFlowApi(host),
      view,
      models: (): readonly ModelSummary[] =>
        (models?.list(session?.location) ?? []).map((info) => ({
          providerID: info.providerID,
          modelID: info.modelID,
          name: info.name,
          variants: info.variants.map((variant) => variant.id),
        })),
      ...(session !== undefined ? { sessionID: session.id } : {}),
    })
  }
  await run().catch((error: unknown) => {
    view.toast(errorText(error), "error")
  })
}
