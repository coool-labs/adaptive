import { observeCodexHeaders, type SharedCapacity } from "../capacity.js"

/** Pi strips model metadata from response hooks. Overlap is not attributable. */
export function dispatchCapacity(shared: SharedCapacity) {
  let provider: string | undefined
  let ambiguous = false
  return {
    selected(selected: string) {
      if (provider !== undefined) ambiguous = true
      provider = selected
    },
    clear() {
      provider = undefined
      ambiguous = false
    },
    async response(headers: unknown) {
      if (!ambiguous && provider !== undefined) await observeCodexHeaders(shared, provider, headers)
    },
  }
}
