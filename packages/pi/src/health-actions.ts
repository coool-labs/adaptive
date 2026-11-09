import { isDeepStrictEqual } from "node:util"
import { parseHealthPayload } from "@coool/adaptive-core/state/health/parse"
import { resourceChain, resourceKeyID } from "@coool/adaptive-core/health/resource-health/key"
import type { ResourceRecord } from "@coool/adaptive-core/health/resource-health/types"
import type { ModelRef } from "@coool/adaptive-core/routing/work-unit/types"
import type { JsonFile } from "./store.js"

export function parseSharedHealth(raw: unknown): ResourceRecord[] {
  if (raw === undefined) return []
  const records = parseHealthPayload(raw)
  if (!isDeepStrictEqual(raw, { version: 1, records }))
    throw new Error("Adaptive health: invalid health.json payload")
  return records
}

export async function readSharedHealth(file: Pick<JsonFile, "read">): Promise<ResourceRecord[]> {
  return parseSharedHealth(await file.read())
}

/** Explicit reset also clears inherited blockers; the UI warns that siblings may be affected. */
export function resetResourceHealth(file: JsonFile, ref: ModelRef): Promise<void> {
  return file.update((current) => {
    const chain = new Set(
      resourceChain({ providerID: ref.providerID, modelID: ref.id, variantID: ref.variant }).map(
        resourceKeyID,
      ),
    )
    const records = parseSharedHealth(current).filter(
      (record) => !chain.has(resourceKeyID(record.key)),
    )
    return { next: { version: 1, records }, result: undefined }
  })
}
