import { Command, Plugin, SettingsPage, type Context } from "@opencode/plugin/gui"
import { For, Show, createSignal, onCleanup } from "solid-js"
import type { JSX } from "solid-js"

import type { OperatingMode } from "./core/scheduler/types.js"
import type { Receipt } from "./state/receipts/index.js"
import type { StatusSnapshot } from "./rpc.js"
import { adaptiveGuiApi, type GuiApi } from "./ui/gui/api.js"
import { modeChoices, parseModeValue, receiptLines, statusRows } from "./ui/gui/view.js"

const RECEIPTS_PREVIEW_LIMIT = 5

/**
 * Native GUI settings page body (ADP-034). All data comes from the typed RPC adapter; the component holds no
 * local settings state. A failed read renders the disconnected row instead of stale data.
 */
export function AdaptiveStatusPage(props: { api: GuiApi }): JSX.Element {
  const [snapshot, setSnapshot] = createSignal<StatusSnapshot | undefined>(undefined)
  const [mode, setMode] = createSignal<OperatingMode>("observe")
  const [receipts, setReceipts] = createSignal<Receipt[]>([])
  const [saved, setSaved] = createSignal(false)

  const refresh = (): void => {
    void props.api.status().then((next) => {
      setSnapshot(next)
      if (next !== undefined) setMode(next.mode)
    })
    void props.api.receipts().then((next) => {
      setReceipts(next ?? [])
    })
  }

  onCleanup(props.api.watchSettings(refresh))
  refresh()

  const pick = (select: HTMLSelectElement): void => {
    const value = parseModeValue(select.value)
    // The DOM changes before onChange, even if the signal stays unchanged
    // after a rejected write. Keep the control on the confirmed server value.
    select.value = mode()
    if (value === undefined) return
    void props.api.update({ mode: value }).then((ok) => {
      setSaved(ok)
      refresh()
    })
  }

  return (
    <div class="adaptive-page">
      <table class="adaptive-status" aria-label="OpenCode Adaptive status">
        <tbody>
          <For each={statusRows(snapshot())}>
            {(row) => (
              <tr class="adaptive-row" data-tone={row.tone}>
                <td class="adaptive-row-label">{row.label}</td>
                <td class="adaptive-row-value">{row.value}</td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
      <label class="adaptive-mode">
        <span class="adaptive-row-label">Mode</span>
        <select
          class="adaptive-mode-select"
          disabled={snapshot() === undefined}
          value={mode()}
          onChange={(event) => {
            pick(event.currentTarget)
          }}
        >
          <For each={modeChoices(mode())}>
            {(choice) => <option value={choice.value}>{choice.title}</option>}
          </For>
        </select>
      </label>
      <Show when={saved()}>
        <span class="adaptive-saved" role="status">
          Saved
        </span>
      </Show>
      <Show when={snapshot() !== undefined}>
        <div class="adaptive-receipts">
          <For each={receiptLines(receipts()).slice(0, RECEIPTS_PREVIEW_LIMIT)}>
            {(line) => <div class="adaptive-receipt-line">{line}</div>}
          </For>
        </div>
      </Show>
    </div>
  )
}

/**
 * GUI plugin entry (the `./gui-experimental` bundle default export). Thin adapter: registers a native
 * SettingsPage and a palette command that opens it; no routing logic lives here (ADP-034/035).
 */
export default Plugin.define({
  setup(context: Context): void {
    const api = adaptiveGuiApi(context.client)
    context.add(SettingsPage, {
      id: "adaptive",
      title: "OpenCode Adaptive",
      entries: [
        {
          id: "adaptive",
          title: "OpenCode Adaptive",
          description: "Execution tier routing, operating mode and resource health",
        },
      ],
      render: () => <AdaptiveStatusPage api={api} />,
    })
    context.add(Command, {
      id: "open",
      title: "OpenCode Adaptive",
      group: "Adaptive",
      run: () => {
        context.layout.settings("adaptive")
      },
    })
  },
})
