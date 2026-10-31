/**
 * Storage seam binding (ADP-030/ADP-031). The supervisor's state stores depend
 * on a minimal `{ read, write }` seam; this module binds that seam to the
 * host's `ctx.storage` under the fixed `coool.adaptive/...` keys. Values are
 * JSON-serializable state payloads (settings/receipts/parked work).
 */
import type { StorageDomain } from "@opencode/plugin/promise/storage"

/** The storage surface the seam actually uses (structural — fixture-friendly). */
export type StorageSource = Pick<StorageDomain, "get" | "set">

export interface JsonSeam {
  read(): Promise<unknown>
  write(value: unknown): Promise<void>
}

/** Bind a storage key to the supervisor seam shape. */
export function storageSeam(key: string, storage: StorageSource): JsonSeam {
  return {
    read: () => storage.get(key),
    write: (value) => storage.set(key, value as Parameters<typeof storage.set>[1]),
  }
}
