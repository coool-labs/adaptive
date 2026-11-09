import { replaceControlCharacters, truncateToWidth } from "@earendil-works/pi-tui"
import { object } from "../settings.js"
import type { AdaptiveNote } from "../ui/notes.js"

export const NOTE_ENTRY = "adaptive.note"

interface NoteComponent {
  render(width: number): string[]
  invalidate(): void
}
interface EntryHost {
  registerEntryRenderer(
    type: string,
    renderer: (
      entry: { readonly data?: unknown },
      options: { readonly expanded: boolean },
      theme: { fg(color: "dim", text: string): string },
    ) => NoteComponent | undefined,
  ): void
}

/** Sanitizes persisted/user-controlled identifiers before they reach the terminal. */
export function fitLine(text: string, width: number): string {
  return truncateToWidth(replaceControlCharacters(text), Math.max(0, width), "…")
}

export function registerEntries(pi: EntryHost): void {
  pi.registerEntryRenderer(NOTE_ENTRY, (entry, options, theme) => {
    const data: unknown = entry.data
    if (!object(data) || data["version"] !== 1 || typeof data["text"] !== "string") return undefined
    const text = data["text"]
    const id = data["receiptID"]
    const detail =
      options.expanded && typeof id === "number" ? ` · receipt #${String(id)} · /adaptive why` : ""
    return {
      render: (width) => [theme.fg("dim", fitLine(`Adaptive · ${text}${detail}`, width))],
      invalidate() {
        /* Rendering is uncached; there is no stale output to discard. */
      },
    }
  })
}

export function appendNote(
  pi: { appendEntry(type: string, data: AdaptiveNote): void },
  note: AdaptiveNote,
): void {
  pi.appendEntry(NOTE_ENTRY, note)
}
