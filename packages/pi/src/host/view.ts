import {
  parseKey,
  replaceControlCharacters,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui"
import type { AdaptiveView } from "@coool/adaptive-core/flow/controller"
import type { SelectOption } from "@coool/adaptive-core/flow/options"
import { fitLine } from "./entries.js"

interface Component {
  render(width: number): string[]
  handleInput(data: string): void
  invalidate(): void
}
interface DialogHost {
  readonly mode: string
  readonly ui: {
    select(title: string, choices: string[]): Promise<string | undefined>
    confirm(title: string, message: string): Promise<boolean>
    input(title: string, placeholder?: string): Promise<string | undefined>
    notify(message: string, type: "info" | "error"): void
    custom<T>(
      factory: (
        tui: { requestRender(): void; terminal: { rows: number } },
        theme: unknown,
        keys: unknown,
        done: (result: T) => void,
      ) => Component,
    ): Promise<T>
  }
}
/**
 * Pi draws a two-line footer under a dialog and mis-renders (drops the dialog's last line) a
 * frame exactly as tall as the terminal, so a dialog keeps one spare row.
 */
function available(rows: number): number {
  return rows - 3
}
interface PickResult<T> {
  picked: T | undefined
  action: string | undefined
}

/** Wrapping keeps whole model names and remedies readable; continuations keep the line's indent. */
function wrap(lines: readonly string[], width: number): string[] {
  return lines.flatMap((raw) => {
    const line = replaceControlCharacters(raw)
    const indent = Math.min(line.length - line.trimStart().length, Math.max(0, width - 1))
    const pad = " ".repeat(indent)
    return wrapTextWithAnsi(line.slice(indent), Math.max(1, width - indent)).map(
      (part) => `${pad}${part}`,
    )
  })
}

/** Search and page actions stay keyboard-accessible without becoming fake model rows. */
export function picker<T>(
  title: string,
  options: readonly SelectOption<T>[],
  actions: readonly { title: string; value: string; bind: string }[],
  height: number,
  done: (result: PickResult<T>) => void,
  refresh: () => void,
): Component {
  let query = ""
  let selected = 0
  const filtered = () =>
    options.filter((option) =>
      `${option.title} ${option.description ?? ""}`.toLowerCase().includes(query.toLowerCase()),
    )
  return {
    render(width) {
      const rows = filtered()
      const headings = wrap(title.split("\n"), width)
      const count = Math.max(1, available(height) - headings.length - actions.length - 2)
      const offset = Math.max(0, selected - count + 1)
      return [
        ...headings,
        `Search: ${query}`,
        ...rows
          .slice(offset, offset + count)
          .map(
            (row, index) =>
              `${offset + index === selected ? ">" : " "} ${row.title}${row.description === undefined ? "" : ` — ${row.description}`}`,
          ),
        ...(rows.length === 0 ? ["No matches"] : []),
        `${String(rows.length)} ${rows.length === 1 ? "choice" : "choices"} · Enter select · Esc back`,
        ...actions.map((action) => `${action.bind}: ${action.title}`),
      ].map((line) => fitLine(line, width))
    },
    handleInput(data) {
      const key = parseKey(data)
      const action = actions.find((candidate) => candidate.bind === key)
      if (action !== undefined) {
        done({ picked: undefined, action: action.value })
        return
      }
      if (key === "escape") {
        done({ picked: undefined, action: undefined })
        return
      }
      const rows = filtered()
      if (key === "enter") {
        done({ picked: rows[selected]?.value, action: undefined })
        return
      }
      if (key === "up") selected = Math.max(0, selected - 1)
      else if (key === "down") selected = Math.min(Math.max(0, rows.length - 1), selected + 1)
      else if (key === "backspace") {
        query = query.slice(0, -1)
        selected = 0
      } else if (/^[^\p{C}]+$/u.test(data)) {
        query = `${query}${data}`.slice(0, 128)
        selected = 0
      }
      refresh()
    },
    invalidate() {
      /* Rendering is uncached; there is no stale output to discard. */
    },
  }
}

export function piView(host: DialogHost): AdaptiveView {
  async function select<T>(
    title: string,
    options: readonly SelectOption<T>[],
    actions: readonly { title: string; value: string; bind: string }[] = [],
  ): Promise<PickResult<T>> {
    if (host.mode === "tui")
      return host.ui.custom<PickResult<T>>((tui, _theme, _keys, done) =>
        picker(title, options, actions, tui.terminal.rows, done, () => {
          tui.requestRender()
        }),
      )
    const search =
      options.length > 20
        ? await host.ui.input(title, "Search provider / model / name (empty shows all)")
        : ""
    if (search === undefined) return { picked: undefined, action: undefined }
    const visible = options.filter((option) =>
      `${option.title} ${option.description ?? ""}`.toLowerCase().includes(search.toLowerCase()),
    )
    const labels = visible.map(
      (option, index) =>
        `${String(index + 1)}. ${option.title}${option.description === undefined ? "" : ` — ${option.description}`}`,
    )
    const actionLabels = actions.map((action) => `${action.bind}: ${action.title}`)
    const chosen = await host.ui.select(title, [...labels, ...actionLabels])
    const index = chosen === undefined ? -1 : labels.indexOf(chosen)
    const actionIndex = chosen === undefined ? -1 : actionLabels.indexOf(chosen)
    return { picked: visible[index]?.value, action: actions[actionIndex]?.value }
  }
  async function text(
    title: string,
    lines: readonly string[],
    compact: readonly string[] = lines,
  ): Promise<void> {
    if (host.mode !== "tui") {
      await host.ui.select(`${title}\n${compact.join("\n")}`, ["Back"])
      return
    }
    await host.ui.custom<undefined>((tui, _theme, _keys, done) => {
      let offset = 0
      let total = Math.max(lines.length, compact.length)
      const count = Math.max(1, available(tui.terminal.rows) - 2)
      return {
        render(width) {
          const shown = wrap(
            lines.some((line) => visibleWidth(line) > width) ? compact : lines,
            width,
          )
          total = shown.length
          offset = Math.min(offset, Math.max(0, total - count))
          return [
            title,
            ...shown.slice(offset, offset + count),
            "↑/↓ scroll · Enter or Esc back",
          ].map((line) => fitLine(line, width))
        },
        handleInput(data) {
          const key = parseKey(data)
          if (key === "escape" || key === "enter") {
            done(undefined)
            return
          }
          if (key === "up") offset = Math.max(0, offset - 1)
          if (key === "down") offset = Math.min(Math.max(0, total - count), offset + 1)
          tui.requestRender()
        },
        invalidate() {
          /* Rendering is uncached; there is no stale output to discard. */
        },
      }
    })
  }
  return {
    select: async (spec) => (await select(spec.title, spec.options)).picked,
    selectPaged: (spec) => select(spec.title, spec.options, spec.actions),
    confirm: (spec) => host.ui.confirm(spec.title, spec.message),
    alert: (spec) => text(spec.title, spec.message.split("\n")),
    table: (spec) => text(spec.title, spec.lines, spec.compactLines),
    toast: (message, variant) => {
      host.ui.notify(message, variant === "error" ? "error" : "info")
    },
  }
}
