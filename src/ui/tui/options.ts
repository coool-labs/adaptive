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
  if (error instanceof Error) return error.message
  // RPC failures surface as plain objects ({type, message}); String() would
  // render "[object Object]" and throw away the only diagnostic the user gets.
  if (typeof error === "object" && error !== null) {
    const message = (error as { message?: unknown }).message
    if (typeof message === "string" && message.length > 0) return message
    // JSON.stringify throws on BigInt values, which host payloads can carry;
    // stringify them as strings instead of losing the whole diagnostic.
    return JSON.stringify(error, (_, value: unknown) =>
      typeof value === "bigint" ? String(value) : value,
    )
  }
  return String(error)
}
