import type { JsonFile, JsonTransactionFile } from "../../src/store.js"

/** Serializes asynchronous transactions just like the cross-process file lock. */
export function memoryFile(
  initial?: unknown,
): JsonFile & JsonTransactionFile & { value(): unknown } {
  let value = initial
  let queue: Promise<unknown> = Promise.resolve()
  const transaction: JsonTransactionFile["transaction"] = (change) => {
    const run = queue.then(async () => {
      const changed = await change(value)
      if (changed.next !== undefined) value = changed.next
      return changed.result
    })
    queue = run.catch(() => undefined)
    return run
  }
  return {
    value: () => value,
    read: () => Promise.resolve(value),
    update: (change) => transaction((current) => Promise.resolve(change(current))),
    transaction,
  }
}
