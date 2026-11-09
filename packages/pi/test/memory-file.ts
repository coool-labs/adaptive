import type { JsonFile, JsonTransactionFile } from "../src/store.js"

export function memoryFile(
  initial?: unknown,
): JsonFile & JsonTransactionFile & { value(): unknown } {
  let value = initial
  return {
    value: () => value,
    read: () => Promise.resolve(value),
    async update(change) {
      const changed = change(value)
      if (changed.next !== undefined) value = changed.next
      return await Promise.resolve(changed.result)
    },
    async transaction(change) {
      const { next, result } = await change(value)
      if (next !== undefined) value = next
      return result
    },
  }
}
