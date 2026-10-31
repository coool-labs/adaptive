/**
 * Shared option shapes for the dialog-driven TUI. These mirror the subset of
 * the host `ui.dialog.select` contract the Adaptive flows use; `tui.ts` adapts
 * them to the real plugin types (structural superset).
 */
export interface SelectOption<Value> {
  readonly title: string
  readonly value: Value
  readonly description?: string
}

export interface SelectSpec<Value> {
  readonly title: string
  readonly placeholder?: string
  readonly options: readonly SelectOption<Value>[]
  readonly current?: Value
  readonly search?: (
    query: string,
    options: readonly SelectOption<Value>[],
  ) => readonly SelectOption<Value>[]
}

/** Friendly one-line rendering of an API failure for toasts. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
